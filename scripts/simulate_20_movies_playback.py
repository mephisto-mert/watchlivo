import asyncio
import concurrent.futures
import json
import os
import sys
import time
import urllib.parse
from starlette.testclient import TestClient

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

client = TestClient(server.app)

MOVIES_TO_TEST = [
    {"id": 1, "title": "Korku Seansı 4: Son Ayin", "provider": "max", "year": "2025", "tmdbId": "1034541", "type": "movie"},
    {"id": 2, "title": "Bir Minecraft Filmi", "provider": "max", "year": "2025", "tmdbId": "950387", "type": "movie"},
    {"id": 3, "title": "Superman", "provider": "max", "year": "2025", "tmdbId": "1064213", "type": "movie"},
    {"id": 4, "title": "Günahkarlar", "provider": "max", "year": "2025", "tmdbId": "1233413", "type": "movie"},
    {"id": 5, "title": "Ballerina", "provider": "max", "year": "2025", "tmdbId": "541134", "type": "movie"},
    {"id": 6, "title": "Rebel Ridge", "provider": "netflix", "year": "2024", "tmdbId": "646097", "type": "movie"},
    {"id": 7, "title": "Damsel", "provider": "netflix", "year": "2024", "tmdbId": "763215", "type": "movie"},
    {"id": 8, "title": "The Union", "provider": "netflix", "year": "2024", "tmdbId": "845111", "type": "movie"},
    {"id": 9, "title": "The Cycle", "provider": "film", "year": "2026", "tmdbId": "1290418", "type": "movie"},
    {"id": 10, "title": "Otis Kasırgası", "provider": "film", "year": "2025", "tmdbId": "1780005", "type": "movie"},
    {"id": 11, "title": "The Last Whale Singer", "provider": "film", "year": "2025", "tmdbId": "1123456", "type": "movie"},
    {"id": 12, "title": "Bad Apples", "provider": "film", "year": "2025", "tmdbId": "1154321", "type": "movie"},
    {"id": 13, "title": "Bleach", "provider": "anime", "year": "2004", "tmdbId": "30984", "type": "tv", "season": 1, "episode": 1},
    {"id": 14, "title": "Berserk (1997)", "provider": "anime", "year": "1997", "tmdbId": "35935", "type": "tv", "season": 1, "episode": 1},
    {"id": 15, "title": "Kolpaçino 4 4'lük", "provider": "dizipal", "year": "2024", "tmdbId": "1189205", "type": "movie"},
    {"id": 16, "title": "Ölümlü Dünya 2", "provider": "dizipal", "year": "2023", "tmdbId": "1143183", "type": "movie"},
    {"id": 17, "title": "Oppenheimer", "provider": "film", "year": "2023", "tmdbId": "872585", "type": "movie"},
    {"id": 18, "title": "Dune: Part Two", "provider": "film", "year": "2024", "tmdbId": "693134", "type": "movie"},
    {"id": 19, "title": "Interstellar", "provider": "netflix", "year": "2014", "tmdbId": "157336", "type": "movie"},
    {"id": 20, "title": "Inception", "provider": "max", "year": "2010", "tmdbId": "27205", "type": "movie"},
]

def simulate_single_movie_watcher(movie_meta):
    subagent_id = f"Subagent-{movie_meta['id']:02d}"
    title = movie_meta["title"]
    provider = movie_meta["provider"]
    log = []
    issues = []
    
    t0 = time.time()
    log.append(f"[{subagent_id}] Starting watch session for '{title}' (Provider: {provider})")
    
    # 1. Resolve Catalog Stream
    params = {
        "provider": provider,
        "title": title,
        "year": movie_meta.get("year", ""),
        "tmdbId": movie_meta.get("tmdbId", ""),
        "mediaType": movie_meta.get("type", "movie"),
        "user_id": f"tris_viewer_{movie_meta['id']}"
    }
    if movie_meta.get("season"):
        params["season"] = str(movie_meta["season"])
    if movie_meta.get("episode"):
        params["episode"] = str(movie_meta["episode"])
        
    res_url = "/api/rave/resolve-catalog?" + urllib.parse.urlencode(params)
    t_resolve_start = time.time()
    try:
        r_resolve = client.get(res_url)
        t_resolve = time.time() - t_resolve_start
        log.append(f"[{subagent_id}] Resolve status: {r_resolve.status_code} in {t_resolve:.2f}s")
    except Exception as e:
        issues.append(f"Resolver exception: {str(e)}")
        elapsed = round(time.time() - t0, 2)
        return {"subagent": subagent_id, "title": title, "provider": provider, "status": "FAIL", "elapsed_sec": elapsed, "issues": issues, "log": log}
        
    if r_resolve.status_code != 200:
        issues.append(f"Resolve failed with HTTP {r_resolve.status_code}: {r_resolve.text[:150]}")
        elapsed = round(time.time() - t0, 2)
        return {"subagent": subagent_id, "title": title, "provider": provider, "status": "FAIL", "elapsed_sec": elapsed, "issues": issues, "log": log}
        
    try:
        resolve_data = r_resolve.json()
    except Exception as e:
        issues.append(f"Resolve response not JSON: {r_resolve.text[:150]}")
        elapsed = round(time.time() - t0, 2)
        return {"subagent": subagent_id, "title": title, "provider": provider, "status": "FAIL", "elapsed_sec": elapsed, "issues": issues, "log": log}
        
    stream_url = resolve_data.get("streamUrl") or resolve_data.get("url") or ""
    streams = resolve_data.get("streams") or []
    is_drm = resolve_data.get("drm") or resolve_data.get("requires_auth") or False
    source = resolve_data.get("source") or resolve_data.get("provider") or ""
    
    log.append(f"[{subagent_id}] Stream resolved in {t_resolve:.2f}s. DRM: {is_drm}, Source: {source}, URL: {stream_url[:60]}..., Total streams: {len(streams)}")
    
    if t_resolve > 8.0:
        issues.append(f"Extreme resolve latency: {t_resolve:.2f}s (target < 2.0s)")
        
    if not stream_url and not streams:
        issues.append("No playable streamUrl or streams list returned in payload")
        elapsed = round(time.time() - t0, 2)
        return {"subagent": subagent_id, "title": title, "provider": provider, "status": "NO_STREAM", "elapsed_sec": elapsed, "issues": issues, "log": log}
        
    primary_stream = stream_url or (streams[0][0] if isinstance(streams[0], (list, tuple)) else streams[0].get("url") if isinstance(streams[0], dict) else streams[0])
    
    # 2. Check Subtitles
    has_subtitles = bool(resolve_data.get("subtitles") or resolve_data.get("subs") or resolve_data.get("subtitleTracks"))
    if not has_subtitles:
        issues.append("No subtitle tracks found for this title (Turkish/English subtitles missing)")
        
    # 3. Stream Segment / Manifest verification
    m3u8_valid = False
    is_hls = ".m3u8" in primary_stream or "/api/rave/stream" in primary_stream or "m3u8" in primary_stream.lower()
    
    if is_hls:
        t_manifest_start = time.time()
        try:
            if primary_stream.startswith("/api/"):
                r_manifest = client.get(primary_stream)
            else:
                proxy_manifest_url = f"/api/rave/stream-manifest?url={urllib.parse.quote(primary_stream)}&probe=1"
                r_manifest = client.get(proxy_manifest_url)
            t_manifest = time.time() - t_manifest_start
            
            log.append(f"[{subagent_id}] Manifest fetch: {r_manifest.status_code} ({len(r_manifest.content)} bytes) in {t_manifest:.2f}s")
            
            if r_manifest.status_code == 200:
                manifest_text = r_manifest.text
                if "#EXTM3U" in manifest_text:
                    m3u8_valid = True
                    if "#EXT-X-KEY" in manifest_text:
                        log.append(f"[{subagent_id}] Stream is encrypted (EXT-X-KEY detected)")
                    seg_matches = [line.strip() for line in manifest_text.splitlines() if line.strip() and not line.startswith("#")]
                    if seg_matches:
                        sample_seg = seg_matches[0]
                        log.append(f"[{subagent_id}] Sample segment: {sample_seg[:50]}")
                        
                        t_seg_start = time.time()
                        if sample_seg.startswith("/api/"):
                            r_seg = client.get(sample_seg, headers={"Range": "bytes=0-16384"})
                        elif sample_seg.startswith("http"):
                            p_seg_u = f"/api/rave/stream-proxy?url={urllib.parse.quote(sample_seg)}"
                            r_seg = client.get(p_seg_u, headers={"Range": "bytes=0-16384"})
                        else:
                            r_seg = None
                            
                        if r_seg:
                            t_seg = time.time() - t_seg_start
                            log.append(f"[{subagent_id}] Segment chunk fetch: {r_seg.status_code} ({len(r_seg.content)} bytes) in {t_seg:.2f}s")
                            if r_seg.status_code not in (200, 206):
                                issues.append(f"Segment chunk download failed with HTTP {r_seg.status_code}")
                    else:
                        issues.append("Master manifest has 0 segments/variants listed")
                else:
                    issues.append("Manifest response lacks #EXTM3U header (binary stream or error page)")
            elif r_manifest.status_code == 206:
                issues.append("Stream returned HTTP 206 Partial Content video stream instead of M3U8 text manifest")
            else:
                issues.append(f"Manifest proxy failed with HTTP {r_manifest.status_code}")
        except Exception as e:
            issues.append(f"Manifest fetch error: {str(e)}")
            
    # 4. Room Creation & Live Peer Synchronization
    t_room_start = time.time()
    room_payload = {
        "name": f"Watch Party {title}",
        "creator": f"TrisWatcher_{movie_meta['id']}",
        "privacy": "public",
        "media": {
            "title": title,
            "url": primary_stream,
            "playing": True,
            "currentTime": 0.0
        }
    }
    r_create = client.post("/api/rooms/create", json=room_payload)
    if r_create.status_code == 200:
        create_data = r_create.json()
        room_obj = create_data.get("room") or {}
        room_id = room_obj.get("id") or ""
        creator_cid = create_data.get("clientId") or ""
        creator_tok = create_data.get("clientToken") or ""
        
        log.append(f"[{subagent_id}] Room created: {room_id}, CID: {creator_cid}")
        
        if not room_id:
            issues.append("Room creation returned 200 but failed to provide room.id")
        else:
            # Host sends seek to 1800.0s (30 mins in)
            sync_payload_seek = {
                "type": "seek",
                "clientId": creator_cid,
                "clientToken": creator_tok,
                "currentTime": 1800.0,
                "playing": True
            }
            r_seek = client.post(f"/api/rooms/{room_id}/sync", json=sync_payload_seek)
            if r_seek.status_code != 200:
                issues.append(f"Seek command failed with HTTP {r_seek.status_code}")
            else:
                log.append(f"[{subagent_id}] Host seek to 1800s accepted (HTTP 200)")
                
            # Peer viewer joins and polls room state
            r_peer = client.post(f"/api/rooms/{room_id}/sync", json={
                "type": "poll",
                "username": f"Peer_Tris_{movie_meta['id']}"
            })
            if r_peer.status_code == 200:
                peer_data = r_peer.json()
                peer_room = peer_data.get("room") or peer_data
                peer_media = peer_room.get("media") or {}
                peer_pos = float(peer_media.get("currentTime") or 0.0)
                if abs(peer_pos - 1800.0) > 15.0:
                    issues.append(f"Clock drift: host set position to 1800.0s but peer read {peer_pos}s")
                else:
                    log.append(f"[{subagent_id}] Peer synchronized accurately at {peer_pos:.1f}s")
            else:
                issues.append(f"Peer sync poll failed with HTTP {r_peer.status_code}")
    else:
        issues.append(f"Room creation failed with HTTP {r_create.status_code}: {r_create.text[:100]}")
        
    elapsed = round(time.time() - t0, 2)
    has_fatal = any("failed with http" in x.lower() or "exception" in x.lower() or "502" in x or "404" in x for x in issues)
    status = "FAIL" if has_fatal else "WARN" if issues else "PASS"
    log.append(f"[{subagent_id}] Finished session in {elapsed:.2f}s with status: {status}")
    
    return {
        "subagent": subagent_id,
        "title": title,
        "provider": provider,
        "status": status,
        "elapsed_sec": elapsed,
        "stream_url": primary_stream[:100] if primary_stream else None,
        "m3u8_valid": m3u8_valid,
        "issues": issues,
        "log": log
    }

def main():
    print(f"=== LAUNCHING CONCURRENT WATCH SIMULATION FOR {len(MOVIES_TO_TEST)} MOVIES VIA 20 SUBAGENTS ===")
    t_start = time.time()
    
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_to_movie = {executor.submit(simulate_single_movie_watcher, m): m for m in MOVIES_TO_TEST}
        for future in concurrent.futures.as_completed(future_to_movie):
            m = future_to_movie[future]
            try:
                data = future.result()
                results.append(data)
                print(f"[{data['subagent']}] {data['title'][:25]:25} | Status: {data['status']:5} | Time: {data['elapsed_sec']}s | Issues: {len(data['issues'])}")
            except Exception as exc:
                print(f"[Subagent-{m['id']:02d}] Exception: {exc}")
                results.append({
                    "subagent": f"Subagent-{m['id']:02d}",
                    "title": m["title"],
                    "provider": m["provider"],
                    "status": "CRASH",
                    "elapsed_sec": 0.0,
                    "issues": [str(exc)],
                    "log": [str(exc)]
                })
                
    total_time = time.time() - t_start
    print(f"\nAll 20 movie sessions completed in {total_time:.2f} seconds.")
    
    results.sort(key=lambda x: x["subagent"])
    
    out_path = os.path.join(base_dir, "audit", "audit_20_movies_playback_results.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": time.time(),
            "total_movies": len(MOVIES_TO_TEST),
            "total_elapsed_sec": round(total_time, 2),
            "results": results
        }, f, indent=2, ensure_ascii=False)
        
    print(f"Full results saved to {out_path}")

if __name__ == "__main__":
    main()
