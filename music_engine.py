# Watchlivo Unified Multi-Platform Music & Music Video Party Engine
# Aggregates real data from Spotify, Apple Music, Deezer, YouTube Music & SoundCloud
import asyncio
import concurrent.futures
import json
import re
import time
import urllib.parse
import urllib.request
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

UA_MUSIC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

MUSIC_CATEGORIES = [
    {"id": "all", "label": "🏠 Tümü & Sana Özel", "query": "türkçe pop rap hit 2025"},
    {"id": "trending", "label": "🔥 Trend & Top 50", "query": "Semicenk Lvbel C5 Blok3 Mabel Matiz Dedublüman"},
    {"id": "tr_pop", "label": "🇹🇷 Türkçe Pop", "query": "Simge Edis Gülşen Hande Yener Tarkan Hadise"},
    {"id": "tr_rap", "label": "🎤 Türkçe Rap & Drill", "query": "Lvbel C5 Blok3 Uzi Motive Ceza Sagopa Kajmer Ati242"},
    {"id": "slow", "label": "💔 Slow & Akustik", "query": "Semicenk Emir Can İğrek Dedublüman Sezen Aksu Yalın"},
    {"id": "arabesk", "label": "🎻 Arabesk & Damar", "query": "Müslüm Gürses Bergen İbrahim Tatlıses Ebru Gündeş Azer Bülbül"},
    {"id": "tr_rock", "label": "🎸 Anadolu & Türkçe Rock", "query": "Duman Mor ve Ötesi maNga Barış Manço Cem Karaca Şebnem Ferah"},
    {"id": "nostalji", "label": "🕰️ 90'lar & 2000'ler", "query": "Tarkan Sezen Aksu Sertab Erener Kenan Doğulu Teoman Levent Yüksel"},
    {"id": "global_pop", "label": "🌍 Yabancı Hit & Pop", "query": "The Weeknd Billie Eilish Taylor Swift Dua Lipa Bruno Mars Lady Gaga"},
    {"id": "phonk", "label": "⚡ Phonk & Remix", "query": "Kordhell Interworld DVRST Eternxlkz Phonk"},
    {"id": "global_rock", "label": "🎸 Yabancı Rock & Efsaneler", "query": "Queen Linkin Park Nirvana Metallica Arctic Monkeys Coldplay"},
]

CATEGORY_SEEDS = {
    "trending": ["Semicenk", "Lvbel C5", "Blok3", "Mabel Matiz", "Dedublüman", "Simge", "Mert Demir"],
    "tr_pop": ["Simge", "Edis", "Gülşen", "Tarkan", "Mabel Matiz", "Hande Yener", "Hadise", "Zeynep Bastık"],
    "tr_rap": ["Lvbel C5", "Blok3", "Ati242", "Motive", "Uzi", "Ceza", "Sagopa Kajmer", "Ezhel"],
    "slow": ["Semicenk", "Dedublüman", "Emir Can İğrek", "Yalın", "Sezen Aksu", "Cem Adrian", "Mavi Gri"],
    "arabesk": ["Müslüm Gürses", "Bergen", "İbrahim Tatlıses", "Ebru Gündeş", "Ferdi Tayfur", "Azer Bülbül"],
    "tr_rock": ["Duman", "Mor ve Ötesi", "maNga", "Barış Manço", "Cem Karaca", "Şebnem Ferah", "Athena"],
    "nostalji": ["Tarkan", "Sezen Aksu", "Sertab Erener", "Teoman", "Kenan Doğulu", "MFÖ", "Levent Yüksel"],
    "global_pop": ["The Weeknd", "Billie Eilish", "Dua Lipa", "Bruno Mars", "Rihanna", "Lady Gaga", "Taylor Swift"],
    "phonk": ["Kordhell", "Interworld", "DVRST", "Eternxlkz", "PlayaPhonk", " Hensonn"],
    "global_rock": ["Queen", "Linkin Park", "Arctic Monkeys", "Nirvana", "Metallica", "Coldplay"],
}

SPOTIFY_PLAYLISTS = {
    "trending": "37i9dQZEVXbIVYVBNw9D5K",   # Top 50 Türkiye
    "tr_pop": "37i9dQZF1DX5cO1uP1XC1g",     # Türkçe Pop
    "tr_rap": "37i9dQZF1DWY4lFlS4Pnso",     # Türkçe Rap
    "tr_rock": "37i9dQZF1DX9wC1KY45plY",    # Türkçe Rock
    "global_pop": "37i9dQZEVXbMDoHDwVN2tF", # Global Top 50
}

_TR_ASCII = str.maketrans("ıİöÖüÜşŞğĞçÇâÂîÎûÛ", "iioouussggccaaiiuu")
_MUSIC_CACHE: dict[str, tuple[float, dict]] = {}
_SIMILAR_CACHE: dict[str, tuple[float, list]] = {}
_RESOLVE_MUSIC_CACHE: dict[str, tuple[float, dict]] = {}
_LYRICS_CACHE: dict[str, tuple[float, str]] = {}
_SPOTIFY_PL_CACHE: dict[str, tuple[float, list]] = {}
_YT_IOS_STREAM_CACHE: dict[str, tuple[float, dict]] = {}

_REMIX_KW_RE = re.compile(
    r"\b(remix|rmx|bootleg|mashup|edit|rework|flip|club\s*mix|extended\s*mix|radio\s*edit|vip\s*mix|"
    r"mixed\s*by|mix|speed\s*up|sped\s*up|slowed|reverb|8d|nightcore|phonk\s*mix|drill\s*remix|afro\s*house|"
    r"tech\s*house|melodic\s*techno|dj\s+[a-z0-9]{2,}|prod\.?\s*(?:by)?|ai\s*cover)\b",
    re.I,
)
_ACOUSTIC_KW_RE = re.compile(r"\b(acoustic|akustik|unplugged|live|canli\s*performans|konser)\b", re.I)
_VERSION_KW_RE = re.compile(r"\b(cover|karaoke|instrumental|enstrumantal|piano\s*version|2\.0|3\.0)\b", re.I)


def _norm_raw(s: str) -> str:
    return str(s or "").translate(_TR_ASCII).lower().replace("\u0307", "")


def _classify_track_variant(title: str, album: str = "", artist: str = "") -> tuple[bool, str]:
    raw = _norm_raw(f"{title or ''} {album or ''} {artist or ''}")
    if _REMIX_KW_RE.search(raw):
        return True, "🎛️ Remix"
    if _ACOUSTIC_KW_RE.search(raw):
        return True, "🎸 Akustik / Canlı"
    if _VERSION_KW_RE.search(raw):
        return True, "🔄 Alternatif Versiyon"
    return False, "✅ Orijinal"


def _ensure_variant_title(title: str, is_var: bool, badge: str) -> str:
    t = (title or "").strip()
    if not is_var or not t:
        return t
    low = _norm_raw(t)
    if "remix" in badge.lower() and not any(k in low for k in ("remix", "rmx", "edit", "mix", "slowed", "sped")):
        return f"{t} (Remix)"
    if "akustik" in badge.lower() and not any(k in low for k in ("akustik", "acoustic", "live", "canli")):
        return f"{t} (Akustik)"
    return t


def _norm_key(s: str) -> str:
    t = _norm_raw(s)
    t = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", t)
    t = re.sub(r"\b(feat|ft|official|video|klip|audio|lyrics|remastered|version|edit|mix)\b", " ", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _track_dedup_key(artist: str, song_title: str, album: str = "") -> str:
    a = _norm_key(artist).split(" ")[0] if _norm_key(artist) else ""
    s = _norm_key(song_title)
    is_var, _ = _classify_track_variant(song_title, album, artist)
    tag = "rmx" if is_var else "orig"
    return f"{a}|{s}|{tag}" if s else ""


def _http_get_json(url: str, timeout: float = 4.5, headers: dict | None = None, data: bytes | None = None):
    hdrs = {"User-Agent": UA_MUSIC, "Accept": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(1024 * 600).decode("utf-8", errors="ignore"))


def _spotify_playlist_sync(playlist_id: str, limit: int = 20) -> list[dict]:
    if not playlist_id:
        return []
    cached = _SPOTIFY_PL_CACHE.get(playlist_id)
    if cached and time.time() - cached[0] < 1800:
        return cached[1][:limit]
    u = f"https://open.spotify.com/embed/playlist/{playlist_id}"
    try:
        req = urllib.request.Request(u, headers={"User-Agent": UA_MUSIC, "Accept-Language": "tr-TR,tr;q=0.9"})
        with urllib.request.urlopen(req, timeout=4.5) as r:
            html = r.read(1024 * 700).decode("utf-8", errors="ignore")
        m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
        if not m:
            return []
        data = json.loads(m.group(1))
        entity = ((data.get("props") or {}).get("pageProps") or {}).get("state", {}).get("data", {}).get("entity") or {}
        cover_list = ((entity.get("coverArt") or {}).get("sources") or [])
        default_cover = cover_list[0].get("url") if cover_list else "/static/kinox-poster.svg"
        tracks = entity.get("trackList") or []
        out = []
        for idx, tr in enumerate(tracks):
            title = (tr.get("title") or "").strip()
            artist = (tr.get("subtitle") or "").replace("\xa0", " ").strip()
            prev = ((tr.get("audioPreview") or {}).get("url") or "").strip()
            uri = (tr.get("uri") or "").strip()
            spk_id = uri.split(":")[-1] if ":" in uri else f"sp_{idx}"
            if not title or not artist:
                continue
            dur_sec = max(30, int((tr.get("duration") or 200000) / 1000))
            out.append({
                "id": f"sp_{spk_id}",
                "trackId": spk_id,
                "title": f"{artist} — {title}",
                "songTitle": title,
                "artist": artist,
                "album": "Spotify Top Listesi",
                "year": "2025",
                "genre": "Spotify Hit",
                "sourcePlatform": "Spotify",
                "sourceBadge": "🟢 Spotify",
                "duration": dur_sec,
                "poster": default_cover,
                "backdrop": default_cover,
                "thumbnail": default_cover,
                "audioPreviewUrl": prev,
                "isMusic": True,
                "mediaType": "music",
            })
        if out:
            _SPOTIFY_PL_CACHE[playlist_id] = (time.time(), out)
        return out[:limit]
    except Exception:
        return []


def _itunes_music_video_sync(term: str, limit: int = 8, country: str = "TR") -> list[dict]:
    if not term.strip():
        return []
    u = "https://itunes.apple.com/search?" + urllib.parse.urlencode({
        "term": term.strip(),
        "country": country,
        "entity": "musicVideo",
        "limit": str(limit),
    })
    try:
        data = _http_get_json(u, timeout=4.2)
    except Exception:
        return []
    out = []
    for it in data.get("results") or []:
        mv_url = (it.get("previewUrl") or "").strip()
        if not mv_url or ".m4v" not in mv_url:
            continue
        tid = str(it.get("trackId") or "")
        title = (it.get("trackName") or "").strip()
        artist = (it.get("artistName") or "").strip()
        if not title or not artist:
            continue
        art100 = it.get("artworkUrl100") or ""
        poster = art100.replace("100x100bb", "600x600bb") if art100 else "/static/kinox-poster.svg"
        dur_sec = max(30, int((it.get("trackTimeMillis") or 200000) / 1000))
        out.append({
            "id": f"amv_{tid}",
            "trackId": tid,
            "title": f"{artist} — {title}",
            "songTitle": title,
            "artist": artist,
            "album": it.get("collectionName") or "Video Klip",
            "year": (it.get("releaseDate") or "2025")[:4],
            "genre": it.get("primaryGenreName") or "Video Klip",
            "sourcePlatform": "Apple Music",
            "sourceBadge": "🍎 Apple Music Klip",
            "duration": dur_sec,
            "poster": poster,
            "backdrop": poster,
            "thumbnail": poster,
            "mvUrl": mv_url,
            "audioPreviewUrl": mv_url,
            "isMusic": True,
            "mediaType": "music",
        })
    return out


def _itunes_search_sync(term: str, limit: int = 20, country: str = "TR") -> list[dict]:
    if not term.strip():
        return []
    u = "https://itunes.apple.com/search?" + urllib.parse.urlencode({
        "term": term.strip(),
        "country": country,
        "media": "music",
        "entity": "song",
        "limit": str(limit),
    })
    try:
        data = _http_get_json(u, timeout=4.2)
    except Exception:
        return []
    out = []
    seen = set()
    for it in data.get("results") or []:
        tid = str(it.get("trackId") or "")
        title = (it.get("trackName") or "").strip()
        artist = (it.get("artistName") or "").strip()
        prev = (it.get("previewUrl") or "").strip()
        if not title or not artist or not prev:
            continue
        dk = _track_dedup_key(artist, title)
        if not dk or dk in seen:
            continue
        seen.add(dk)
        art100 = it.get("artworkUrl100") or ""
        poster = art100.replace("100x100bb", "600x600bb") if art100 else "/static/kinox-poster.svg"
        dur_sec = max(30, int((it.get("trackTimeMillis") or 200000) / 1000))
        out.append({
            "id": f"trk_{tid}" if tid else f"trk_{abs(hash(dk)) % 10000000}",
            "trackId": tid,
            "title": f"{artist} — {title}",
            "songTitle": title,
            "artist": artist,
            "album": it.get("collectionName") or "",
            "year": (it.get("releaseDate") or "2025")[:4],
            "genre": it.get("primaryGenreName") or "Müzik",
            "sourcePlatform": "Apple Music",
            "sourceBadge": "🍎 Apple Music",
            "duration": dur_sec,
            "poster": poster,
            "backdrop": poster,
            "thumbnail": poster,
            "audioPreviewUrl": prev,
            "isMusic": True,
            "mediaType": "music",
        })
    return out


def _deezer_search_sync(term: str, limit: int = 12) -> list[dict]:
    if not term.strip():
        return []
    u = "https://api.deezer.com/search?" + urllib.parse.urlencode({"q": term.strip(), "limit": str(limit)})
    try:
        data = _http_get_json(u, timeout=4.0)
    except Exception:
        return []
    out = []
    for it in data.get("data") or []:
        title = (it.get("title_short") or it.get("title") or "").strip()
        artist = ((it.get("artist") or {}).get("name") or "").strip()
        prev = (it.get("preview") or "").strip()
        if not title or not artist:
            continue
        alb = it.get("album") or {}
        poster = alb.get("cover_xl") or alb.get("cover_big") or alb.get("cover_medium") or "/static/kinox-poster.svg"
        out.append({
            "id": f"dz_{it.get('id')}",
            "trackId": str(it.get("id") or ""),
            "title": f"{artist} — {title}",
            "songTitle": title,
            "artist": artist,
            "album": alb.get("title") or "Deezer Hi-Fi",
            "year": "2025",
            "genre": "Deezer Hi-Fi",
            "sourcePlatform": "Deezer",
            "sourceBadge": "🟣 Deezer Hi-Fi",
            "duration": max(30, int(it.get("duration") or 200)),
            "poster": poster,
            "backdrop": poster,
            "thumbnail": poster,
            "audioPreviewUrl": prev,
            "isMusic": True,
            "mediaType": "music",
        })
    return out


def _yt_innertube_search_sync(query: str, limit: int = 10) -> list[dict]:
    if not query.strip():
        return []
    body = json.dumps({
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20250101.00.00",
                "hl": "tr",
                "gl": "TR",
            }
        },
        "query": query.strip(),
    }).encode("utf-8")
    try:
        data = _http_get_json(
            "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
            timeout=4.5,
            headers={"Content-Type": "application/json"},
            data=body,
        )
    except Exception:
        return []
    sections = (
        data.get("contents", {})
        .get("twoColumnSearchResultsRenderer", {})
        .get("primaryContents", {})
        .get("sectionListRenderer", {})
        .get("contents", [])
    )
    items = []
    for sec in sections:
        for it in sec.get("itemSectionRenderer", {}).get("contents", []):
            vr = it.get("videoRenderer")
            if not vr or not vr.get("videoId"):
                continue
            vid = vr["videoId"]
            raw_title = "".join(r.get("text", "") for r in vr.get("title", {}).get("runs", []))
            chan = "".join(r.get("text", "") for r in vr.get("ownerText", {}).get("runs", []))
            dur_str = vr.get("lengthText", {}).get("simpleText", "") or "3:30"
            parts = [int(p) for p in dur_str.split(":") if p.isdigit()]
            dur_sec = sum(v * (60 ** idx) for idx, v in enumerate(reversed(parts))) if parts else 210
            if dur_sec > 7200:
                continue
            artist = chan.replace(" - Topic", "").replace("VEVO", "").strip() or "Sanatçı"
            song_title = raw_title
            for sep in (" - ", " – ", " — "):
                if sep in raw_title:
                    sp = raw_title.split(sep, 1)
                    artist, song_title = sp[0].strip(), sp[1].strip()
                    break
            thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
            items.append({
                "id": f"ytm_{vid}",
                "videoId": vid,
                "title": f"{artist} — {song_title}",
                "songTitle": song_title,
                "artist": artist,
                "album": "YouTube Music Klip",
                "year": "2025",
                "genre": "YouTube Music",
                "sourcePlatform": "YouTube Music",
                "sourceBadge": "🔴 YouTube Music",
                "duration": dur_sec,
                "poster": thumb,
                "backdrop": thumb,
                "thumbnail": thumb,
                "isMusic": True,
                "mediaType": "music",
            })
            if len(items) >= limit:
                return items
    return items


def _dedup_and_enrich(lists: list[list[dict]], global_seen: set | None = None, allow_remix: bool = False) -> list[dict]:
    by_key: dict[str, dict] = {}
    order: list[str] = []
    seen = global_seen if global_seen is not None else set()
    for group in lists:
        for item in (group or []):
            s_title = item.get("songTitle") or ""
            s_album = item.get("album") or ""
            s_artist = item.get("artist") or ""
            is_var, var_badge = _classify_track_variant(s_title, s_album, s_artist)
            if is_var and not allow_remix:
                continue
            disp_song = _ensure_variant_title(s_title, is_var, var_badge)
            dk = _track_dedup_key(s_artist, disp_song, s_album)
            if not dk:
                continue
            if dk in by_key:
                cur = by_key[dk]
                if item.get("mvUrl") and not cur.get("mvUrl"):
                    cur["mvUrl"] = item["mvUrl"]
                if item.get("audioPreviewUrl") and not cur.get("audioPreviewUrl"):
                    cur["audioPreviewUrl"] = item["audioPreviewUrl"]
                if item.get("videoId") and not cur.get("videoId"):
                    cur["videoId"] = item["videoId"]
                if item.get("poster") and ("scdn.co" in cur.get("poster", "") or "kinox-poster" in cur.get("poster", "")) and "mzstatic.com" in item.get("poster", ""):
                    cur["poster"] = item["poster"]
                    cur["backdrop"] = item["poster"]
                    cur["thumbnail"] = item["poster"]
                continue
            if dk in seen:
                continue
            seen.add(dk)
            copy_it = dict(item)
            copy_it["songTitle"] = disp_song
            copy_it["title"] = f"{s_artist} — {disp_song}" if s_artist else disp_song
            copy_it["isRemix"] = is_var
            copy_it["versionBadge"] = var_badge
            by_key[dk] = copy_it
            order.append(dk)
    res_list = [by_key[k] for k in order]
    if allow_remix:
        res_list.sort(key=lambda x: 1 if x.get("isRemix") else 0)
    return res_list


def _detect_artist_category(artist: str, genre: str = "") -> str:
    a_low = (artist or "").lower()
    g_low = (genre or "").lower()
    for cat_id, seeds in CATEGORY_SEEDS.items():
        for s in seeds:
            if s.lower() in a_low or a_low in s.lower():
                return cat_id
    if "rap" in g_low or "hip-hop" in g_low:
        return "tr_rap"
    if "rock" in g_low or "alternative" in g_low:
        return "tr_rock"
    if "arabesk" in g_low:
        return "arabesk"
    return "trending"


def _find_similar_songs_sync(artist: str, song_title: str = "", category: str = "", limit: int = 16) -> list[dict]:
    ckey = f"{artist.lower().strip()}|{song_title.lower().strip()}|{category}"
    cached = _SIMILAR_CACHE.get(ckey)
    if cached and time.time() - cached[0] < 900:
        return cached[1][:limit]
    cat = category if category in CATEGORY_SEEDS else _detect_artist_category(artist)
    peers = [s for s in CATEGORY_SEEDS.get(cat, CATEGORY_SEEDS["trending"]) if s.lower() != artist.lower().strip()]
    seed_key = _track_dedup_key(artist, song_title)
    seen = {seed_key} if seed_key else set()
    batches = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        f_art_mv = pool.submit(_itunes_music_video_sync, artist.strip(), 4) if artist.strip() else None
        f_art_it = pool.submit(_itunes_search_sync, artist.strip(), 6) if artist.strip() else None
        f_dz = pool.submit(_deezer_search_sync, artist.strip() or peers[0], 6)
        f_peers = [pool.submit(_itunes_search_sync, p, 4) for p in peers[:3]]
        if f_art_mv:
            batches.append(f_art_mv.result() or [])
        if f_art_it:
            batches.append(f_art_it.result() or [])
        batches.append(f_dz.result() or [])
        for fp in f_peers:
            batches.append(fp.result() or [])
    merged = _dedup_and_enrich(batches, seen)
    for idx, t in enumerate(merged):
        t["similarReason"] = f"🎵 {artist} Benzeri · {t.get('sourceBadge', '🍎 Apple Music')}" if idx < 4 and artist else f"✨ {artist or 'Radyo'} Mix · {t.get('sourceBadge', '🟢 Spotify')}"
    _SIMILAR_CACHE[ckey] = (time.time(), merged)
    return merged[:limit]


def _fetch_lrc_vtt_sync(artist: str, song_title: str) -> str:
    clean_title = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", song_title or "").strip()
    clean_title = re.sub(r"(?i)\b(?:feat\.?|ft\.?|prod\.?|official|video|audio|klip|lyrics|original|stüdyo)\b.*$", "", clean_title).strip() or (song_title or "").strip()
    clean_artist = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", artist or "").strip()
    q = f"{clean_artist} {clean_title}".strip() or f"{artist} {song_title}".strip()
    if not q:
        return "WEBVTT\n\n1\n00:00:01.000 --> 00:00:08.000\n🎤 Watchlivo Hi-Fi Müzik & Karaoke\n"
    ckey = q.lower()
    if ckey in _LYRICS_CACHE and time.time() - _LYRICS_CACHE[ckey][0] < 3600:
        return _LYRICS_CACHE[ckey][1]
    queries = [q]
    if clean_title and clean_title not in queries:
        queries.append(clean_title)
    lrc_text = ""
    plain_text = ""
    for q_try in queries:
        u = "https://lrclib.net/api/search?" + urllib.parse.urlencode({"q": q_try})
        try:
            rows = _http_get_json(u, timeout=4.0, headers={"User-Agent": "Watchlivo/2.0 (https://watchlivo.online)"})
        except Exception:
            rows = []
        for row in (rows or []):
            if row.get("syncedLyrics") and not lrc_text:
                lrc_text = row["syncedLyrics"]
                break
            if row.get("plainLyrics") and not plain_text:
                plain_text = row["plainLyrics"]
        if lrc_text:
            break
    parsed = []
    if lrc_text:
        for m in re.finditer(r"\[(\d{2}):(\d{2})[.:](\d{2,3})\]([^\n\r]*)", lrc_text):
            mm, ss, ms_raw, txt = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4).strip()
            ms = int(ms_raw) * (10 if len(ms_raw) == 2 else 1)
            sec = mm * 60 + ss + ms / 1000.0
            if txt:
                parsed.append((sec, txt))
    if not parsed and plain_text:
        lines = [ln.strip() for ln in plain_text.splitlines() if ln.strip()]
        for idx_l, ln in enumerate(lines[:60]):
            parsed.append((6.0 + idx_l * 3.8, ln))
    if not parsed:
        disp_head = f"{clean_artist} — {clean_title}".strip(" —") or q
        parsed = [
            (1.0, f"{disp_head} · Hi-Fi Stüdyo"),
            (8.0, f"{clean_title or disp_head} · Orijinal Kayıt"),
            (16.0, f"{clean_artist or 'Watchlivo Müzik'} · Senkron Ses Akışı"),
        ]
    cues = []
    for idx, (st, txt) in enumerate(parsed):
        et = parsed[idx + 1][0] - 0.08 if idx + 1 < len(parsed) else st + 4.5
        if et <= st + 0.3:
            et = st + 2.5
        sh, sm, s_rem = int(st // 3600), int((st % 3600) // 60), st % 60
        eh, em, e_rem = int(et // 3600), int((et % 3600) // 60), et % 60
        cues.append(f"{idx + 1}\n{sh:02d}:{sm:02d}:{s_rem:06.3f} --> {eh:02d}:{em:02d}:{e_rem:06.3f}\n🎤 {txt}")
    vtt = "WEBVTT\n\n" + "\n\n".join(cues) + "\n"
    _LYRICS_CACHE[ckey] = (time.time(), vtt)
    return vtt


def _build_music_catalog_sync(provider: str, category: str, query: str, recent_artist: str, recent_title: str) -> dict:
    if query.strip():
        q_clean = query.strip()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            f_mv = pool.submit(_itunes_music_video_sync, q_clean, 8)
            f_it = pool.submit(_itunes_search_sync, q_clean, 18)
            f_dz = pool.submit(_deezer_search_sync, q_clean, 12)
            f_yt = pool.submit(_yt_innertube_search_sync, f"{q_clean} official video klip", 8)
            combined = _dedup_and_enrich([
                f_mv.result() or [],
                f_it.result() or [],
                f_dz.result() or [],
                f_yt.result() or [],
            ], allow_remix=True)
        sim = _find_similar_songs_sync(combined[0]["artist"] if combined else q_clean, combined[0]["songTitle"] if combined else "", category, limit=12)
        return {
            "provider": "music",
            "category": category,
            "categories": MUSIC_CATEGORIES,
            "items": combined[:32],
            "similarItems": sim,
            "shelves": [
                {"id": "search", "title": f"🔍 '{q_clean}' — Spotify · Apple Music · Deezer · YT Music Sonuçları", "items": combined[:24]}
            ] + ([{"id": "similar", "title": "✨ Benzer Müzikler & Diğer Şarkılar", "items": sim}] if sim else []),
        }
    ckey = f"v5|music|{category}|{recent_artist.lower()}|{recent_title.lower()}"
    cached = _MUSIC_CACHE.get(ckey)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    shelves = []
    all_items = []
    global_seen: set[str] = set()
    target_cats = [c for c in MUSIC_CATEGORIES if c["id"] != "all"] if category in ("all", "") else [c for c in MUSIC_CATEGORIES if c["id"] == category]
    if not target_cats:
        target_cats = [MUSIC_CATEGORIES[1]]

    def _fetch_cat_raw(c_obj: dict) -> list[list[dict]]:
        cid = c_obj["id"]
        seeds = CATEGORY_SEEDS.get(cid, ["Semicenk", "Mabel Matiz", "Duman"])
        sp_pl = SPOTIFY_PLAYLISTS.get(cid, "")
        batches = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as sub_pool:
            f_sp = sub_pool.submit(_spotify_playlist_sync, sp_pl, 6) if sp_pl else None
            f_mv = sub_pool.submit(_itunes_music_video_sync, seeds[0], 4)
            f_dz = sub_pool.submit(_deezer_search_sync, seeds[1 if len(seeds) > 1 else 0], 5)
            f_yt = sub_pool.submit(_yt_innertube_search_sync, f"{seeds[2 if len(seeds) > 2 else 0]} official klip", 4)
            f_it = [sub_pool.submit(_itunes_search_sync, s, 4 if category == "all" else 7) for s in seeds[:2]]
            if f_sp:
                batches.append(f_sp.result() or [])
            batches.append(f_mv.result() or [])
            batches.append(f_dz.result() or [])
            batches.append(f_yt.result() or [])
            for fi in f_it:
                batches.append(fi.result() or [])
        return batches

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as main_pool:
        f_sim = main_pool.submit(_find_similar_songs_sync, recent_artist or "Semicenk", recent_title or "Çıkmaz Bir Sokakta", category, 14)
        cat_futs = [(c, main_pool.submit(_fetch_cat_raw, c)) for c in target_cats]
        sim_items = f_sim.result() or []
        cat_raw_results = [(c, fut.result() or []) for c, fut in cat_futs]

    rap_block = ("lvbel", "blok3", "uzi", "motive", "ati242", "cakal", "reckol", "batuflex", "murda")
    for c, batches in cat_raw_results:
        cid = c["id"]
        cat_tracks = _dedup_and_enrich(batches, global_seen if category in ("all", "") else set(), allow_remix=(cid == "phonk"))
        if cid in ("slow", "nostalji", "arabesk", "tr_rock"):
            cat_tracks = [t for t in cat_tracks if not any(rb in (t.get("artist") or "").lower() for rb in rap_block)]
        for t in cat_tracks:
            t["categoryId"] = cid
            t["categoryLabel"] = c["label"]
        if cat_tracks:
            shelves.append({"id": cid, "title": f"{c['label']} · {len(cat_tracks)} Parça", "items": cat_tracks[:18]})
            all_items.extend(cat_tracks)
    res = {
        "provider": "music",
        "category": category or "all",
        "categories": MUSIC_CATEGORIES,
        "items": all_items[:48],
        "similarItems": sim_items,
        "shelves": shelves,
    }
    _MUSIC_CACHE[ckey] = (time.time(), res)
    return res


_SC_CLIENT_ID = "3GKD969NJWD1eB6gvQJN0GnueYbcWszv"
_SC_CID_TS = 0.0


def _get_sc_client_id_sync(force_refresh: bool = False) -> str:
    global _SC_CLIENT_ID, _SC_CID_TS
    if _SC_CLIENT_ID and not force_refresh and (time.time() - _SC_CID_TS < 3600):
        return _SC_CLIENT_ID
    try:
        req = urllib.request.Request("https://soundcloud.com/", headers={"User-Agent": UA_MUSIC})
        with urllib.request.urlopen(req, timeout=4.0) as r:
            html = r.read().decode("utf-8", errors="ignore")
        scripts = re.findall(r'src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)"', html)
        for s_url in reversed(scripts[-5:]):
            with urllib.request.urlopen(urllib.request.Request(s_url, headers={"User-Agent": UA_MUSIC}), timeout=4.0) as sr:
                js = sr.read().decode("utf-8", errors="ignore")
            m = re.search(r'client_id\s*:\s*"([a-zA-Z0-9]{32})"', js)
            if m:
                _SC_CLIENT_ID = m.group(1)
                _SC_CID_TS = time.time()
                return _SC_CLIENT_ID
    except Exception:
        pass
    return _SC_CLIENT_ID


def _sc_resolve_full_track_sync(artist: str, song_title: str, expected_dur_sec: int = 0, want_remix: bool = False) -> dict | None:
    clean_s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", song_title or "").strip() or (song_title or "").strip()
    clean_s = re.sub(r"(?i)\b(?:feat\.?|ft\.?|prod\.?|official|video|audio|klip|lyrics)\b.*$", "", clean_s).strip() or clean_s
    queries = []
    for q_cand in (f"{artist} {clean_s}".strip(), f"{artist} {song_title}".strip(), clean_s.strip()):
        if q_cand and q_cand not in queries:
            queries.append(q_cand)
    if not queries:
        return None
    norm_s = _norm_key(clean_s) or _norm_key(song_title)
    norm_a = _norm_key(artist).split(" ")[0] if _norm_key(artist) else ""
    for attempt in range(2):
        cid = _get_sc_client_id_sync(force_refresh=(attempt == 1))
        if not cid:
            continue
        for q in queries:
            try:
                u = "https://api-v2.soundcloud.com/search/tracks?" + urllib.parse.urlencode({"q": q, "client_id": cid, "limit": "20"})
                data = _http_get_json(u, timeout=4.5)
                coll = data.get("collection") or []
                if not coll:
                    continue
                candidates = []
                for item in coll:
                    dur_ms = int(item.get("duration") or 0)
                    dur_sec = int(round(dur_ms / 1000.0))
                    if dur_ms < 65000 or dur_ms > 540000:
                        continue
                    raw_it_title = str(item.get("title") or "")
                    raw_it_user = str((item.get("user") or {}).get("username") or "")
                    is_it_remix, _ = _classify_track_variant(raw_it_title, "", raw_it_user)
                    if not want_remix and is_it_remix:
                        continue
                    if not want_remix and expected_dur_sec >= 65 and abs(dur_sec - expected_dur_sec) > 22:
                        continue
                    trans = (item.get("media") or {}).get("transcodings") or []
                    valid_trans = []
                    for pref in ("aac_160k", "aac_96k", "mp3_0_1", "mp3_0_0", "mp3_1_0", "opus_0_0", "abr_sq"):
                        for t in trans:
                            if not t.get("snipped") and t.get("preset") == pref and t.get("url") and t not in valid_trans:
                                valid_trans.append(t)
                    for t in trans:
                        if not t.get("snipped") and t.get("url") and t not in valid_trans:
                            valid_trans.append(t)
                    if not valid_trans:
                        continue
                    it_title = _norm_key(raw_it_title)
                    it_user = _norm_key(raw_it_user)
                    if norm_s and norm_s not in it_title:
                        continue
                    score = 65
                    if norm_a and (norm_a in it_title or norm_a in it_user):
                        score += 45
                    elif norm_a:
                        continue
                    if expected_dur_sec >= 65:
                        score += max(0, 25 - abs(dur_sec - expected_dur_sec))
                    candidates.append((score, dur_ms, valid_trans, item))
                if not candidates:
                    continue
                candidates.sort(key=lambda x: x[0], reverse=True)
                resolved_streams = []
                primary_meta = None
                for _, best_dur_ms, trans_list, best_item in candidates[:6]:
                    for best_t in trans_list:
                        try:
                            t_url = best_t["url"] + ("&" if "?" in best_t["url"] else "?") + f"client_id={cid}"
                            s_obj = _http_get_json(t_url, timeout=3.2)
                            s_url = (s_obj or {}).get("url") or ""
                            if not s_url or "/cbcs/" in s_url or "/cenc/" in s_url or s_url in resolved_streams:
                                continue
                            resolved_streams.append(s_url)
                            if not primary_meta:
                                proto = ((best_t.get("format") or {}).get("protocol") or "hls").lower()
                                art = (best_item.get("artwork_url") or "").replace("-large", "-t500x500")
                                primary_meta = {
                                    "url": s_url,
                                    "duration": max(65, int(round(best_dur_ms / 1000.0))),
                                    "streamType": "hls" if "hls" in proto or ".m3u8" in s_url else "mp4",
                                    "preset": best_t.get("preset") or "aac_160k",
                                    "artwork": art,
                                }
                            break
                        except Exception:
                            continue
                    if len(resolved_streams) >= 3:
                        break
                if primary_meta:
                    primary_meta["altUrls"] = resolved_streams[1:4]
                    return primary_meta
            except Exception:
                continue
    return None


UA_YT_IOS = "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)"


def _yt_ios_extract_sync(video_id: str) -> dict | None:
    vid = (video_id or "").strip()
    if not re.match(r"^[A-Za-z0-9_-]{11}$", vid):
        return None
    cached = _YT_IOS_STREAM_CACHE.get(vid)
    if cached and time.time() - cached[0] < 1200:
        return cached[1]
    payload = {
        "videoId": vid,
        "context": {
            "client": {
                "clientName": "IOS",
                "clientVersion": "20.03.02",
                "deviceMake": "Apple",
                "deviceModel": "iPhone16,2",
                "osName": "iPhone",
                "osVersion": "18.2.1.22C161",
                "hl": "tr",
                "gl": "TR",
            }
        },
    }
    try:
        req = urllib.request.Request(
            "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": UA_YT_IOS},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5.0) as r:
            data = json.loads(r.read(1024 * 900).decode("utf-8", errors="ignore"))
        sd = data.get("streamingData") or {}
        fmts = (sd.get("adaptiveFormats") or []) + (sd.get("formats") or [])
        audio_url = ""
        video_url = ""
        for pref_itag in (140, 139, 251, 250):
            for f in fmts:
                if f.get("itag") == pref_itag and f.get("url"):
                    audio_url = f["url"]
                    break
            if audio_url:
                break
        for pref_vitag in (136, 135, 134, 18):
            for f in fmts:
                if f.get("itag") == pref_vitag and f.get("url"):
                    video_url = f["url"]
                    break
            if video_url:
                break
        dur_s = int((data.get("videoDetails") or {}).get("lengthSeconds") or 0)
        if audio_url or video_url:
            out = {"audioUrl": audio_url, "videoUrl": video_url, "duration": dur_s}
            _YT_IOS_STREAM_CACHE[vid] = (time.time(), out)
            return out
    except Exception:
        pass
    return None


def _proxy_yt_range_sync(target_url: str, range_hdr: str, default_ct: str):
    hdrs = {"User-Agent": UA_YT_IOS, "Accept": "*/*"}
    chunk_sz = 2048 * 1024
    start, end = 0, chunk_sz - 1
    if range_hdr and range_hdr.startswith("bytes="):
        m = re.match(r"bytes=(\d+)-(\d*)", range_hdr)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else start + chunk_sz - 1
            if end - start >= chunk_sz:
                end = start + chunk_sz - 1
    hdrs["Range"] = f"bytes={start}-{end}"
    req = urllib.request.Request(target_url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=9.0) as r:
        data = r.read(chunk_sz + 1024)
        cr = r.headers.get("Content-Range") or ""
        ct = (r.headers.get("Content-Type") or default_ct).split(";")[0].strip()
        status = 206 if cr else 200
        return data, status, cr, ct


def _yt_fallback_audio_url_sync(vid: str) -> str:
    try:
        oemb = _http_get_json(f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json", timeout=3.5)
        raw_t = (oemb or {}).get("title") or ""
        raw_a = (oemb or {}).get("author_name") or ""
        if raw_t:
            it_res = _itunes_search_sync(f"{raw_a} {raw_t}".strip(), 3)
            for it in (it_res or []):
                if it.get("audioPreviewUrl"):
                    return it["audioPreviewUrl"]
    except Exception:
        pass
    it_def = _itunes_search_sync("Semicenk", 2)
    for it in (it_def or []):
        if it.get("audioPreviewUrl"):
            return it["audioPreviewUrl"]
    return ""


async def yt_music_stream(request: Request):
    vid = (request.query_params.get("v") or request.query_params.get("videoId") or "").strip()[:20]
    kind = (request.query_params.get("kind") or "audio").strip().lower()
    info = await asyncio.wait_for(asyncio.to_thread(_yt_ios_extract_sync, vid), timeout=6.5)
    target = (info or {}).get("videoUrl" if kind == "video" else "audioUrl") or (info or {}).get("audioUrl") or ""
    if not target:
        target = await asyncio.wait_for(asyncio.to_thread(_yt_fallback_audio_url_sync, vid), timeout=5.0)
    if not target:
        return JSONResponse({"error": "Akış bulunamadı"}, status_code=404)
    rng = request.headers.get("range") or ("bytes=0-1023" if request.method == "HEAD" else "")
    def_ct = "video/mp4" if kind == "video" else "audio/mp4"
    try:
        data, status, cr, ct = await asyncio.wait_for(asyncio.to_thread(_proxy_yt_range_sync, target, rng, def_ct), timeout=11.0)
        hdrs = {
            "Content-Type": ct,
            "Content-Length": str(len(data)),
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=1800",
        }
        if cr and status == 206:
            hdrs["Content-Range"] = cr
        return Response(b"" if request.method == "HEAD" else data, status_code=status, headers=hdrs)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)


def _resolve_music_sync(artist: str, song_title: str, video_id: str, url: str, provider: str, poster: str, preview_url: str, mv_url_param: str = "", mode: str = "") -> dict:
    is_generic_title = not song_title or song_title.strip() in ("Müzik & Klip Parçası", "Müzik", "Track")
    if url and is_generic_title:
        try:
            if "open.spotify.com/" in url:
                oemb = _http_get_json("https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe=""), timeout=4.0)
                song_title = oemb.get("title") or song_title
                poster = oemb.get("thumbnail_url") or poster
            elif "deezer.com/" in url:
                m_dz = re.search(r"track/(\d+)", url)
                if m_dz:
                    dz_d = _http_get_json(f"https://api.deezer.com/track/{m_dz.group(1)}", timeout=4.0)
                    if dz_d and dz_d.get("title"):
                        song_title = dz_d.get("title") or song_title
                        artist = (dz_d.get("artist") or {}).get("name") or artist
                        poster = (dz_d.get("album") or {}).get("cover_xl") or poster
                        preview_url = dz_d.get("preview") or preview_url
            elif "music.apple.com/" in url:
                m_ap = re.search(r"[?&]i=(\d+)|/(\d{7,12})(?:[/?#]|$)", url)
                ap_id = (m_ap.group(1) or m_ap.group(2)) if m_ap else ""
                if ap_id:
                    ap_d = _http_get_json(f"https://itunes.apple.com/lookup?id={ap_id}&country=TR", timeout=4.0)
                    res_ap = (ap_d or {}).get("results") or []
                    if res_ap:
                        song_title = res_ap[0].get("trackName") or res_ap[0].get("collectionName") or song_title
                        artist = res_ap[0].get("artistName") or artist
                        poster = (res_ap[0].get("artworkUrl100") or "").replace("100x100bb", "600x600bb") or poster
                        preview_url = res_ap[0].get("previewUrl") or preview_url
            elif "youtube.com/" in url or "youtu.be/" in url:
                m_yt = re.search(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})", url)
                if m_yt:
                    video_id = video_id or m_yt.group(1)
                    oemb = _http_get_json(f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json", timeout=4.0)
                    song_title = oemb.get("title") or song_title
                    artist = artist or (oemb.get("author_name") or "").replace(" - Topic", "").strip()
            elif "soundcloud.com/" in url:
                oemb = _http_get_json("https://soundcloud.com/oembed?format=json&url=" + urllib.parse.quote(url, safe=""), timeout=4.0)
                song_title = oemb.get("title") or song_title
                artist = artist or oemb.get("author_name") or ""
                poster = oemb.get("thumbnail_url") or poster
        except Exception:
            pass
    if not artist and "—" in song_title:
        sp = song_title.replace("🎵", "").split("—", 1)
        artist, song_title = sp[0].strip(), sp[1].strip()
    elif not artist and " - " in song_title:
        sp = song_title.replace("🎵", "").split(" - ", 1)
        artist, song_title = sp[0].strip(), sp[1].strip()
    want_remix, var_badge = _classify_track_variant(song_title, "", artist)
    clean_q = f"{artist} {song_title}".strip() or "Semicenk Çıkmaz Bir Sokakta"
    mode_norm = "video" if mode.lower() in ("video", "clip", "mv") else ("audio" if mode.lower() in ("audio", "song") else "")
    ckey = f"v14|{clean_q.lower()}|{'rmx' if want_remix else 'orig'}|{mode_norm}"
    cached = _RESOLVE_MUSIC_CACHE.get(ckey)
    if cached and time.time() - cached[0] < 120:
        return cached[1]

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        f_mv_exact = pool.submit(_itunes_music_video_sync, clean_q, 6)
        f_mv_art = pool.submit(_itunes_music_video_sync, artist or clean_q, 6)
        f_it = pool.submit(_itunes_search_sync, clean_q, 6)
        f_dz = pool.submit(_deezer_search_sync, clean_q, 4)
        f_yt_aud = pool.submit(_yt_innertube_search_sync, f"{clean_q} official audio" if not want_remix else clean_q, 6)
        f_yt_clip = pool.submit(_yt_innertube_search_sync, f"{clean_q} official video klip", 6)
        mv_hits = (f_mv_exact.result() or []) + (f_mv_art.result() or [])
        it_hits = f_it.result() or []
        dz_hits = f_dz.result() or []
        yt_aud_hits = f_yt_aud.result() or []
        yt_clip_hits = f_yt_clip.result() or []

    target_norm_s = _norm_key(song_title)
    official_dur_sec = 0
    audio_stream = preview_url if (preview_url and not preview_url.endswith(".m4v")) else ""
    source_plat = "Apple Music"
    for trk in it_hits + dz_hits:
        t_prev = trk.get("audioPreviewUrl") or ""
        t_is_rmx, _ = _classify_track_variant(trk.get("songTitle") or "", trk.get("album") or "", trk.get("artist") or "")
        if not want_remix and t_is_rmx:
            continue
        if not artist:
            artist = trk.get("artist") or artist
        if not song_title:
            song_title = trk.get("songTitle") or song_title
        if not poster or "scdn.co" in poster or "kinox-poster" in poster:
            poster = trk.get("poster") or poster
        if target_norm_s and target_norm_s in _norm_key(trk.get("songTitle", "")):
            if not official_dur_sec and int(trk.get("duration") or 0) >= 60:
                official_dur_sec = int(trk.get("duration") or 0)
            if t_prev:
                audio_stream = t_prev
                source_plat = trk.get("sourcePlatform") or "Apple Music"
                break
        elif t_prev and not audio_stream:
            audio_stream = t_prev
            source_plat = trk.get("sourcePlatform") or "Apple Music"

    sc_full = _sc_resolve_full_track_sync(artist or clean_q, song_title or clean_q, expected_dur_sec=official_dur_sec, want_remix=want_remix)

    exact_mv = ""
    artist_mv = mv_url_param if (mv_url_param and ".m4v" in mv_url_param) else ""
    for mh in mv_hits:
        u_mv = mh.get("mvUrl") or ""
        if not u_mv:
            continue
        if not artist_mv:
            artist_mv = u_mv
        if target_norm_s and (target_norm_s in _norm_key(mh.get("songTitle", "")) or _norm_key(mh.get("songTitle", "")) in target_norm_s):
            exact_mv = u_mv
            poster = mh.get("poster") or poster
            break

    cand_vids = []
    audio_vid = ""
    clip_vid = ""
    yt_dur = 0
    for yh in yt_aud_hits + yt_clip_hits:
        vid = yh.get("videoId")
        if not vid:
            continue
        yh_title_raw = yh.get("songTitle") or yh.get("title") or ""
        yh_rmx, _ = _classify_track_variant(yh_title_raw, "", yh.get("artist") or "")
        if not want_remix and yh_rmx:
            continue
        if target_norm_s and target_norm_s not in _norm_key(yh_title_raw):
            continue
        d_y = int(yh.get("duration") or 0)
        if not want_remix and official_dur_sec >= 60 and d_y >= 60 and abs(d_y - official_dur_sec) > 22:
            continue
        if vid not in cand_vids:
            cand_vids.append(vid)
        if not clip_vid and yh in yt_clip_hits and d_y >= 60:
            clip_vid = vid
        if not audio_vid and d_y >= 60:
            audio_vid = vid
            yt_dur = d_y
    if video_id and re.match(r"^[A-Za-z0-9_-]{11}$", video_id) and video_id not in cand_vids:
        cand_vids.insert(0, video_id)
    primary_vid = audio_vid or (cand_vids[0] if cand_vids else "")
    clip_vid = clip_vid or primary_vid
    if not yt_dur and cand_vids:
        for yh in yt_aud_hits + yt_clip_hits:
            if yh.get("videoId") == primary_vid and int(yh.get("duration") or 0) >= 60:
                yt_dur = int(yh.get("duration") or 0)
                break

    sc_url = (sc_full or {}).get("url") or ""
    sc_alts = list((sc_full or {}).get("altUrls") or [])
    sc_dur = int((sc_full or {}).get("duration") or 0)
    sc_stype = (sc_full or {}).get("streamType") or "hls"
    if sc_full and sc_full.get("artwork") and (not poster or "kinox-poster" in poster or "watchlivo-poster" in poster):
        poster = sc_full["artwork"]

    full_dur = official_dur_sec or sc_dur or yt_dur or 200
    fmt_m, fmt_s = divmod(full_dur, 60)
    fmt_dur_lbl = f"{fmt_m}:{fmt_s:02d}"

    audio_tracks = []
    if sc_url:
        audio_tracks.append({"id": "full-studio", "lang": "orig", "targetLang": "orig", "label": f"🎵 {var_badge} Stüdyo Ses ({fmt_dur_lbl} · Hi-Fi)", "mode": "stream", "url": sc_url})
    for idx_alt, alt_u in enumerate(sc_alts[:2]):
        audio_tracks.append({"id": f"full-alt-{idx_alt + 1}", "lang": "orig", "targetLang": "orig", "label": f"🎵 Alternatif Tam Süre Kaynak #{idx_alt + 2} ({fmt_dur_lbl})", "mode": "stream", "url": alt_u})
    if exact_mv:
        audio_tracks.append({"id": "mv-hd", "lang": "orig", "targetLang": "orig", "label": "🎬 Resmi HD Video Klip (Apple Music 1080p)", "mode": "stream", "url": exact_mv})

    is_preview_mv = bool(exact_mv and re.search(r"Video211|mzvf_|AudioPreview", str(exact_mv), re.I))
    if sc_url:
        primary_prov = "direct"
        primary_stype = sc_stype
        primary_url = sc_url
        alt_urls = [u for u in (sc_alts + ([exact_mv] if not is_preview_mv else []) + [audio_stream]) if u and u != primary_url]
    elif mode_norm == "video" and exact_mv and not is_preview_mv:
        primary_prov = "direct"
        primary_stype = "mp4"
        primary_url = exact_mv
        alt_urls = [u for u in ([sc_url] + sc_alts + [audio_stream, artist_mv]) if u and u != primary_url]
    elif primary_vid:
        primary_prov = "youtube"
        primary_stype = "youtube"
        primary_url = f"https://www.youtube.com/watch?v={clip_vid if mode_norm == 'video' and clip_vid else primary_vid}"
        alt_urls = []
    elif exact_mv:
        primary_prov = "direct"
        primary_stype = "mp4"
        primary_url = exact_mv
        alt_urls = [u for u in [audio_stream, artist_mv] if u and u != primary_url]
    else:
        primary_prov = "direct"
        primary_stype = "mp4"
        primary_url = audio_stream or artist_mv
        alt_urls = [u for u in [audio_stream, artist_mv] if u and u != primary_url]

    disp_song = _ensure_variant_title(song_title, want_remix, var_badge)
    disp_title = f"{artist} — {disp_song}" if artist and disp_song and artist.lower() not in disp_song.lower() else (disp_song or clean_q)
    lyrics_vtt_url = "/api/rave/music-lyrics.vtt?" + urllib.parse.urlencode({"artist": artist, "title": song_title})
    sim = _find_similar_songs_sync(artist or clean_q, song_title, "", limit=14)
    res = {
        "provider": primary_prov,
        "streamType": primary_stype,
        "catalogProvider": "music",
        "musicPlatformLabel": f"{source_plat} · {var_badge}",
        "isMusic": True,
        "musicMode": mode_norm or ("video" if (exact_mv and not sc_url) else "audio"),
        "isRemix": want_remix,
        "versionBadge": var_badge,
        "mediaType": "music",
        "url": primary_url,
        "altUrls": alt_urls,
        "audioTracks": audio_tracks,
        "videoId": primary_vid,
        "clipVideoId": clip_vid or primary_vid,
        "altVideoIds": cand_vids[1:5],
        "title": f"🎵 {disp_title}",
        "songTitle": disp_song or disp_title,
        "artist": artist or "Sanatçı",
        "poster": poster or (f"https://i.ytimg.com/vi/{primary_vid}/hqdefault.jpg" if primary_vid else "/static/watchlivo-poster.svg"),
        "thumbnail": poster or (f"https://i.ytimg.com/vi/{primary_vid}/hqdefault.jpg" if primary_vid else "/static/watchlivo-poster.svg"),
        "audioPreviewUrl": sc_url or audio_stream or exact_mv,
        "mvUrl": exact_mv or artist_mv or "",
        "duration": full_dur,
        "channel": f"{artist or 'Sanatçı'} · {var_badge} · Tam Süre ({fmt_dur_lbl})",
        "subtitleTracks": [{"id": "lyrics-tr", "lang": "tr", "label": "🎤 Senkron Şarkı Sözleri (Karaoke)", "url": lyrics_vtt_url, "default": True}],
        "similar": sim,
    }
    _RESOLVE_MUSIC_CACHE[ckey] = (time.time(), res)
    return res


async def music_catalog(request: Request):
    prov = (request.query_params.get("provider") or "music").strip().lower()
    cat = (request.query_params.get("category") or "all").strip().lower()
    q = (request.query_params.get("q") or "").strip()[:120]
    rec_artist = (request.query_params.get("recentArtist") or "Semicenk").strip()[:80]
    rec_title = (request.query_params.get("recentTitle") or "").strip()[:80]
    data = await asyncio.wait_for(asyncio.to_thread(_build_music_catalog_sync, prov, cat, q, rec_artist, rec_title), timeout=12.0)
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=120, s-maxage=600, stale-while-revalidate=1800"})


async def music_similar(request: Request):
    artist = (request.query_params.get("artist") or "").strip()[:80]
    title = (request.query_params.get("title") or "").strip()[:100]
    cat = (request.query_params.get("category") or "").strip()[:40]
    if not artist and "—" in title:
        sp = title.replace("🎵", "").split("—", 1)
        artist, title = sp[0].strip(), sp[1].strip()
    items = await asyncio.wait_for(asyncio.to_thread(_find_similar_songs_sync, artist or "Semicenk", title, cat, 16), timeout=9.0)
    return JSONResponse({"artist": artist, "title": title, "items": items}, headers={"Cache-Control": "public, max-age=120, s-maxage=600"})


async def music_resolve(request: Request):
    artist = (request.query_params.get("artist") or "").strip()[:80]
    title = (request.query_params.get("title") or request.query_params.get("songTitle") or "").strip()[:120]
    vid = (request.query_params.get("videoId") or "").strip()[:20]
    url = (request.query_params.get("url") or "").strip()[:500]
    prov = (request.query_params.get("provider") or "music").strip()[:30]
    poster = (request.query_params.get("poster") or "").strip()[:500]
    prev_u = (request.query_params.get("audioPreviewUrl") or "").strip()[:500]
    mv_u = (request.query_params.get("mvUrl") or "").strip()[:500]
    mode = (request.query_params.get("mode") or "").strip()[:20]
    res = await asyncio.wait_for(asyncio.to_thread(_resolve_music_sync, artist, title, vid, url, prov, poster, prev_u, mv_u, mode), timeout=11.0)
    return JSONResponse(res, headers={"Cache-Control": "public, max-age=60, s-maxage=90"})


async def music_lyrics_vtt(request: Request):
    artist = (request.query_params.get("artist") or "").strip()[:80]
    title = (request.query_params.get("title") or "").strip()[:100]
    vtt = await asyncio.wait_for(asyncio.to_thread(_fetch_lrc_vtt_sync, artist, title), timeout=6.0)
    return Response(vtt.encode("utf-8"), media_type="text/vtt; charset=utf-8", headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600, s-maxage=86400"})
