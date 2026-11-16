"""
End-to-End Live Playback Session & UX Acceptance Benchmark against https://watchlivo.online.
Automated multi-step test verifying room creation, multi-peer synchronization,
playback state transitions, chat propagation, media replacement, and latency benchmarks.
"""

import json
import os
import sys
import time
import urllib.request
import uuid
from typing import Any, Dict, List, Tuple

BASE_URL = os.environ.get("WATCHLIVO_TARGET", "https://watchlivo.online").rstrip("/")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

benchmark_results: List[Dict[str, Any]] = []

def record_metric(step_num: int, action: str, latency_ms: float, status: str, details: str):
    benchmark_results.append({
        "step": step_num,
        "action": action,
        "latency_ms": round(latency_ms, 2),
        "status": status,
        "details": details
    })

def http_post(endpoint: str, payload: Dict[str, Any]) -> Tuple[int, Dict[str, Any], float]:
    url = f"{BASE_URL}{endpoint}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Accept": "application/json"
        },
        method="POST"
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=12) as resp:
        body = resp.read().decode("utf-8")
        latency = (time.perf_counter() - t0) * 1000.0
        return resp.status, json.loads(body), latency

def http_get(endpoint: str) -> Tuple[int, Dict[str, Any], float]:
    url = f"{BASE_URL}{endpoint}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json"
        },
        method="GET"
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=12) as resp:
        body = resp.read().decode("utf-8")
        latency = (time.perf_counter() - t0) * 1000.0
        return resp.status, json.loads(body), latency

def run_e2e_benchmark():
    print("=" * 80)
    print(" WATCHLIVO LIVE PLAYBACK SESSION & UX ACCEPTANCE BENCHMARK")
    print(f" Target Endpoint: {BASE_URL}")
    print("=" * 80)

    # -------------------------------------------------------------------------
    # STEP 1: Create a room with a valid media stream
    # -------------------------------------------------------------------------
    host_cid = "h_" + uuid.uuid4().hex[:8]
    create_payload = {
        "name": "Live Playback Benchmark Room",
        "clientId": host_cid,
        "creator": "Host_Benchmark",
        "media": {
            "provider": "youtube",
            "videoId": "dQw4w9WgXcQ",
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Never Gonna Give You Up (Official Music Video)",
            "duration": 212.0,
            "currentTime": 0.0
        }
    }
    st, res_create, lat_create = http_post("/api/rooms/create", create_payload)
    assert st == 200, f"Step 1 Failed: HTTP status {st}"
    assert res_create.get("ok") is True, f"Step 1 Failed: Response not ok: {res_create}"
    room = res_create.get("room") or {}
    room_id = room.get("id")
    assert room_id, "Step 1 Failed: Missing room id"
    record_metric(1, "Create Room With Media", lat_create, "PASS", f"Room ID: {room_id}")
    print(f"[STEP 1 PASS] Room created: {room_id} (RTT: {lat_create:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 2: Verify host token returned
    # -------------------------------------------------------------------------
    t_tok_start = time.perf_counter()
    host_token = res_create.get("clientToken")
    ret_host_cid = res_create.get("clientId")
    assert host_token and isinstance(host_token, str), "Step 2 Failed: host token is empty"
    assert ret_host_cid == host_cid, f"Step 2 Failed: clientId mismatch {ret_host_cid} vs {host_cid}"
    tok_parts = host_token.split(".")
    assert len(tok_parts) == 3, f"Step 2 Failed: invalid token structure: {host_token}"
    assert tok_parts[0] == host_cid, f"Step 2 Failed: token cid prefix mismatch {tok_parts[0]} vs {host_cid}"
    lat_tok = (time.perf_counter() - t_tok_start) * 1000.0
    record_metric(2, "Verify Host Token", lat_tok, "PASS", f"Token: {host_token[:22]}... (3-segment signed)")
    print(f"[STEP 2 PASS] Host token verified: {host_token[:25]}... (Host CID: {host_cid})")

    # Host registers active presence
    _, res_host_init, lat_h_init = http_post(f"/api/rooms/{room_id}/sync", {
        "type": "init",
        "clientId": host_cid,
        "clientToken": host_token,
        "username": "Host_Benchmark"
    })
    assert res_host_init.get("ok") is True, "Host initial sync failed"

    # -------------------------------------------------------------------------
    # STEP 3: Simulate Guest joining room with separate client ID
    # -------------------------------------------------------------------------
    guest_cid = "g_" + uuid.uuid4().hex[:8]
    guest_join_payload = {
        "type": "init",
        "clientId": guest_cid,
        "username": "Guest_Auditor"
    }
    st, res_guest_join, lat_guest_join = http_post(f"/api/rooms/{room_id}/sync", guest_join_payload)
    assert st == 200, f"Step 3 Failed: HTTP status {st}"
    assert res_guest_join.get("ok") is True, f"Step 3 Failed: Guest join not ok: {res_guest_join}"
    guest_token = res_guest_join.get("clientToken")
    assert guest_token, "Step 3 Failed: Missing guest clientToken"
    assert res_guest_join.get("clientId") == guest_cid, "Step 3 Failed: Guest CID mismatch"
    # In edge zero-trust architecture (edge_rooms.js:286), host_id is masked as "" for non-host viewers; local server returns host_cid
    assert res_guest_join.get("room", {}).get("host_id") in (host_cid, ""), "Step 3 Failed: Host hijacked by guest"
    guest_parts = res_guest_join.get("room", {}).get("participants", [])
    assert any(p.get("isHost") or p.get("clientId") == host_cid or p.get("id") == host_cid for p in guest_parts), "Step 3 Failed: Host missing from participants"
    record_metric(3, "Guest Join Room", lat_guest_join, "PASS", f"Guest CID: {guest_cid}, Host Preserved: {host_cid}")
    print(f"[STEP 3 PASS] Guest joined: {guest_cid} (RTT: {lat_guest_join:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 4: Host issues "play" action at currentTime=0
    # -------------------------------------------------------------------------
    play_payload = {
        "type": "play",
        "clientId": host_cid,
        "clientToken": host_token,
        "currentTime": 0.0
    }
    st, res_play, lat_play = http_post(f"/api/rooms/{room_id}/sync", play_payload)
    assert st == 200, f"Step 4 Failed: HTTP status {st}"
    assert res_play.get("ok") is True, f"Step 4 Failed: Play response not ok: {res_play}"
    assert not res_play.get("errors"), f"Step 4 Failed with errors: {res_play.get('errors')}"
    media_after_play = res_play.get("room", {}).get("media", {})
    assert media_after_play.get("playing") is True, "Step 4 Failed: Media playing flag is not True"
    assert float(media_after_play.get("currentTime") or 0.0) == 0.0, "Step 4 Failed: currentTime != 0.0"
    record_metric(4, "Host Action: play(currentTime=0)", lat_play, "PASS", "playing=True, position=0.0s")
    print(f"[STEP 4 PASS] Host play action dispatched (RTT: {lat_play:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 5: Wait 2 seconds, Guest polls /api/rooms/{id}/sync, assert liveTime is between 1.5s and 2.5s
    # -------------------------------------------------------------------------
    print("... Sleeping 2.00 seconds to measure elapsed playback ...")
    t_sleep_start = time.perf_counter()
    time.sleep(2.0)
    actual_slept = time.perf_counter() - t_sleep_start

    st, res_guest_sync, lat_guest_sync = http_post(f"/api/rooms/{room_id}/sync", {
        "clientId": guest_cid,
        "clientToken": guest_token
    })
    assert st == 200, f"Step 5 Failed: HTTP status {st}"
    guest_media = res_guest_sync.get("room", {}).get("media", {})
    live_time = float(guest_media.get("liveTime") or 0.0)
    assert 1.5 <= live_time <= 2.5, f"Step 5 Failed: liveTime {live_time:.3f}s out of expected [1.5s, 2.5s] (slept {actual_slept:.3f}s)"
    record_metric(5, "Guest Poll Sync (2s Check)", lat_guest_sync, "PASS", f"liveTime={live_time:.3f}s (Target: 1.5s - 2.5s)")
    print(f"[STEP 5 PASS] Guest sync verified: liveTime = {live_time:.3f}s within [1.5s, 2.5s] (RTT: {lat_guest_sync:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 6: Host issues "seek" action to 60.0s
    # -------------------------------------------------------------------------
    seek_payload = {
        "type": "seek",
        "clientId": host_cid,
        "clientToken": host_token,
        "currentTime": 60.0
    }
    st, res_seek, lat_seek = http_post(f"/api/rooms/{room_id}/sync", seek_payload)
    assert st == 200, f"Step 6 Failed: HTTP status {st}"
    assert res_seek.get("ok") is True, f"Step 6 Failed: Seek not ok: {res_seek}"
    assert not res_seek.get("errors"), f"Step 6 Failed: Seek errors: {res_seek.get('errors')}"
    seek_media = res_seek.get("room", {}).get("media", {})
    assert float(seek_media.get("currentTime") or 0.0) == 60.0, f"Step 6 Failed: Host seek currentTime != 60.0"
    record_metric(6, "Host Action: seek(currentTime=60.0)", lat_seek, "PASS", "currentTime anchored to 60.0s")
    print(f"[STEP 6 PASS] Host seek to 60.0s dispatched (RTT: {lat_seek:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 7: Guest polls /sync within 500ms, assert currentTime is 60.0s
    # -------------------------------------------------------------------------
    time.sleep(0.05)  # rapid poll within 50ms (well under 500ms limit)
    st, res_guest_seek_poll, lat_guest_seek_poll = http_post(f"/api/rooms/{room_id}/sync", {
        "clientId": guest_cid,
        "clientToken": guest_token
    })
    assert st == 200, f"Step 7 Failed: HTTP status {st}"
    g_media_after_seek = res_guest_seek_poll.get("room", {}).get("media", {})
    g_curr_time = float(g_media_after_seek.get("currentTime") or 0.0)
    assert g_curr_time == 60.0, f"Step 7 Failed: Guest observed currentTime {g_curr_time} != 60.0"
    record_metric(7, "Guest Poll Seek Sync (<500ms)", lat_guest_seek_poll, "PASS", f"currentTime={g_curr_time}s")
    print(f"[STEP 7 PASS] Guest observed seek currentTime = {g_curr_time}s (RTT: {lat_guest_seek_poll:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 8: Guest issues "chat" message "Merhaba oda!", assert message appears in messages list
    # -------------------------------------------------------------------------
    chat_text = "Merhaba oda!"
    chat_payload = {
        "type": "chat",
        "clientId": guest_cid,
        "clientToken": guest_token,
        "text": chat_text
    }
    st, res_chat, lat_chat = http_post(f"/api/rooms/{room_id}/sync", chat_payload)
    assert st == 200, f"Step 8 Failed: HTTP status {st}"
    assert res_chat.get("ok") is True, f"Step 8 Failed: Chat response not ok: {res_chat}"
    chat_list = res_chat.get("room", {}).get("chat", [])
    chat_match = next((m for m in chat_list if m.get("text") == chat_text and m.get("cid") == guest_cid), None)
    assert chat_match is not None, f"Step 8 Failed: Message '{chat_text}' from guest '{guest_cid}' not in chat list"
    record_metric(8, "Guest Action: chat('Merhaba oda!')", lat_chat, "PASS", f"Message id: {chat_match.get('id')}")
    print(f"[STEP 8 PASS] Chat message received and propagated: '{chat_text}' (RTT: {lat_chat:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 9: Host changes media to a secondary title, assert room media updates for both peers
    # -------------------------------------------------------------------------
    secondary_media = {
        "type": "change_media",
        "clientId": host_cid,
        "clientToken": host_token,
        "provider": "youtube",
        "videoId": "kJQP7kiw5Fk",
        "url": "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
        "title": "Luis Fonsi - Despacito ft. Daddy Yankee",
        "duration": 282.0,
        "currentTime": 0.0
    }
    st, res_change_media, lat_change_media = http_post(f"/api/rooms/{room_id}/sync", secondary_media)
    assert st == 200, f"Step 9 Failed: HTTP status {st}"
    assert res_change_media.get("ok") is True, f"Step 9 Failed: Change media not ok"
    host_seen_title = res_change_media.get("room", {}).get("media", {}).get("title")
    assert host_seen_title == secondary_media["title"], f"Host media title mismatch: {host_seen_title}"

    # Guest polls to verify propagation
    st, res_guest_media_poll, lat_guest_media_poll = http_post(f"/api/rooms/{room_id}/sync", {
        "clientId": guest_cid,
        "clientToken": guest_token
    })
    guest_seen_title = res_guest_media_poll.get("room", {}).get("media", {}).get("title")
    guest_seen_url = res_guest_media_poll.get("room", {}).get("media", {}).get("url")
    assert guest_seen_title == secondary_media["title"], f"Guest media title mismatch: {guest_seen_title}"
    assert guest_seen_url == secondary_media["url"], f"Guest media URL mismatch: {guest_seen_url}"
    total_change_lat = lat_change_media + lat_guest_media_poll
    record_metric(9, "Host Action: change_media(Despacito)", total_change_lat, "PASS", f"Updated title '{secondary_media['title']}' verified across peers")
    print(f"[STEP 9 PASS] Media changed and verified across peers: '{guest_seen_title}' (Host RTT: {lat_change_media:.2f}ms, Guest RTT: {lat_guest_media_poll:.2f}ms)")

    # -------------------------------------------------------------------------
    # STEP 10: Multi-poll Jitter & Compile Full Benchmark
    # -------------------------------------------------------------------------
    poll_latencies = []
    for i in range(5):
        _, _, lat_p = http_post(f"/api/rooms/{room_id}/sync", {
            "clientId": guest_cid,
            "clientToken": guest_token
        })
        poll_latencies.append(lat_p)
        time.sleep(0.05)
    
    avg_poll_rtt = sum(poll_latencies) / len(poll_latencies)
    min_poll_rtt = min(poll_latencies)
    max_poll_rtt = max(poll_latencies)
    record_metric(10, "Sync Polling Burst (5 Cycles)", avg_poll_rtt, "PASS", f"Min: {min_poll_rtt:.2f}ms, Max: {max_poll_rtt:.2f}ms, Avg: {avg_poll_rtt:.2f}ms")

    # Clean up room
    try:
        http_post(f"/api/rooms/{room_id}/sync", {
            "type": "close_room",
            "clientId": host_cid,
            "clientToken": host_token
        })
    except Exception:
        pass

    print("\n" + "=" * 80)
    print(" BENCHMARK COMPILATION TABLE")
    print("=" * 80)
    print("| Step | Action / Verification | Latency (ms) | Status | Verification Summary |")
    print("|:----:|:----------------------|:------------:|:------:|:---------------------|")
    for r in benchmark_results:
        print(f"| {r['step']} | {r['action']:<28} | {r['latency_ms']:>8.2f}ms | {r['status']:<6} | {r['details']} |")
    print("=" * 80)
    
    return benchmark_results

if __name__ == "__main__":
    results = run_e2e_benchmark()
