# -*- coding: utf-8 -*-
"""
Watchlivo - In-Room Playable Stream Resolution for Max (HBO)
Ensures Max movies/series play directly inside the room player with HLS,
while maintaining account gating for unauthenticated users.
"""

import sys
import io
import os
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

BASE_DIR = Path(__file__).resolve().parent.parent
server_path = BASE_DIR / "server.py"
content = server_path.read_text(encoding="utf-8")

# Block 1 to remove: lines 6443-6486 early return that blocked direct_stream extraction
old_early_block = """        if is_max_prov:
            pmeta = _fetch_platform_meta_sync("max", tr_title or orig_title, tid, mtype)
            official_url = source_url or pmeta.get("officialUrl") or ""
            if not official_url or ("play.max.com" not in official_url and "hbomax.com" not in official_url):
                hits = _justwatch_sync(_clean_query_title(disp or tr_title or orig_title), ["mxx", "hbm"], "US", 6)
                match = next((h for h in hits if tid and str(h.get("tmdbId")) == str(tid)), hits[0] if hits else None)
                if match and match.get("officialUrl"):
                    official_url = match["officialUrl"]
            if not official_url:
                official_url = "https://play.max.com"
            full_title = f"{disp} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else f"{disp}{f' ({year})' if year and year not in disp else ''}"
            dur = ((m_cached or {}).get("runtime") or (48 if mtype == "tv" else 120)) * 60
            return {
                "id": eff_tid or tid,
                "provider": "max",
                "catalogProvider": "max",
                "tmdbId": tid,
                "imdbId": imdb_id,
                "mediaType": mtype,
                "season": s if mtype == "tv" else 0,
                "episode": e if mtype == "tv" else 0,
                "seriesTitle": disp or tr_title or orig_title,
                "originalTitle": orig_title,
                "year": year,
                "origLang": orig_lang,
                "sourceUrl": source_url or official_url,
                "streamType": "official",
                "url": official_url,
                "embedUrl": official_url,
                "altUrls": [],
                "servers": [{"id": "srv-max-1", "label": "Max (HBO) Resmi Akış (4K Ultra HD)", "url": official_url, "streamType": "official"}],
                "subtitleTracks": [],
                "audioTracks": [{"id": "max-orig", "lang": orig_lang or "en", "label": "Orijinal Ses (Max)", "mode": "stream", "url": official_url}],
                "intro": None,
                "platformAudioLangs": pmeta.get("audioLangs") or ["en", "tr"],
                "platformSubLangs": pmeta.get("subLangs") or ["tr", "en"],
                "officialUrl": official_url,
                "providerUrl": official_url,
                "title": full_title,
                "thumbnail": poster,
                "channel": "Max (HBO) · Resmi Oynatıcı (1080p HD)",
                "duration": dur,
                "authenticated": True,
            }"""

if old_early_block in content:
    content = content.replace(old_early_block, "")
    print("[+] Removed early official block before stream extraction")
else:
    print("[!] old_early_block not found in server.py")

# Block 2: In lines ~6595, if direct_list is found, DO NOT replace it with official URL!
# Only enforce auth gating if not is_auth_user!
old_gating_block = """            if eff_prov in ("max", "hbomax") or primary_p in ("max", "hbomax") or pmeta.get("prov") in ("max", "hbomax"):
                if not is_auth_user:
                    return {
                        "error": "Bu içerik Max (HBO) resmi aboneliği gerektirir. Lütfen Max hesabınızla oturum açın.",
                        "authRequired": True,
                        "provider": "max",
                    }
                official_url = source_url or pmeta.get("officialUrl") or ""
                if not official_url or ("play.max.com" not in official_url and "hbomax.com" not in official_url):
                    hits = _justwatch_sync(_clean_query_title(disp or tr_title or orig_title), ["mxx", "hbm"], "US", 6)
                    match = next((h for h in hits if tid and str(h.get("tmdbId")) == str(tid)), hits[0] if hits else None)
                    if match and match.get("officialUrl"):
                        official_url = match["officialUrl"]
                if not official_url:
                    official_url = "https://play.max.com"
                full_title = f"{disp} — {s}. Sezon {e}. Bölüm" if mtype == "tv" else f"{disp}{f' ({year})' if year and year not in disp else ''}"
                dur = ((m_cached or {}).get("runtime") or (48 if mtype == "tv" else 120)) * 60
                return {
                    "id": eff_tid or tid,
                    "provider": "max",
                    "catalogProvider": "max",
                    "tmdbId": tid,
                    "imdbId": imdb_id,
                    "mediaType": mtype,
                    "season": s if mtype == "tv" else 0,
                    "episode": e if mtype == "tv" else 0,
                    "seriesTitle": disp or tr_title or orig_title,
                    "originalTitle": orig_title,
                    "year": year,
                    "origLang": orig_lang,
                    "sourceUrl": source_url or official_url,
                    "streamType": "official",
                    "url": official_url,
                    "embedUrl": official_url,
                    "altUrls": [],
                    "servers": [{"id": "srv-max-1", "label": "Max (HBO) Resmi Akış (4K Ultra HD)", "url": official_url, "streamType": "official"}],
                    "subtitleTracks": [],
                    "audioTracks": [{"id": "max-orig", "lang": orig_lang or "en", "label": "Orijinal Ses (Max)", "mode": "stream", "url": official_url}],
                    "intro": None,
                    "platformAudioLangs": pmeta.get("audioLangs") or ["en", "tr"],
                    "platformSubLangs": pmeta.get("subLangs") or ["tr", "en"],
                    "officialUrl": official_url,
                    "providerUrl": official_url,
                    "title": full_title,
                    "thumbnail": poster,
                    "channel": "Max (HBO) · Resmi Oynatıcı (1080p HD)",
                    "duration": dur,
                    "authenticated": True,
                }"""

new_gating_block = """            if eff_prov in ("max", "hbomax") or primary_p in ("max", "hbomax") or pmeta.get("prov") in ("max", "hbomax"):
                if not is_auth_user:
                    return {
                        "error": "Bu içerik Max (HBO) resmi aboneliği gerektirir. Lütfen Max hesabınızla oturum açın.",
                        "authRequired": True,
                        "provider": "max",
                    }
                # User IS authenticated! Let direct_list proceed so it streams directly in Watchlivo room!"""

if old_gating_block in content:
    content = content.replace(old_gating_block, new_gating_block)
    print("[+] Replaced gating block so authenticated users get direct playable room stream")
else:
    print("[!] old_gating_block not found in server.py")

server_path.write_text(content, encoding="utf-8")
print("[+] Finished patching server.py")
