"""
Peer 4 Seek/Scrubbing Synchronization Verification Suite
Target: https://watchlivo.online
Media: Sintel open-licensed HLS test stream (CC-BY, ~888s)
Topology: 4 Concurrent Browser Peers (Leader + 3 Guests)
"""
import asyncio
import json
import os
import sys
import time
import urllib.request
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://watchlivo.online"
SHOTS_DIR = os.path.join(os.path.dirname(__file__), "shots_peer4")
os.makedirs(SHOTS_DIR, exist_ok=True)

test_results = []

def record(name, passed, detail=""):
    test_results.append({"name": name, "passed": bool(passed), "detail": str(detail)})
    mark = "PASS" if passed else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail else ""), flush=True)

async def dbg(page):
    try:
        return await page.evaluate("() => window.vortexDebug ? window.vortexDebug() : null")
    except Exception:
        return None

async def poll_page(page):
    try:
        await page.evaluate("""() => {
            if (window.__vortexActiveConn?.outQueue?.length) {
                window.__vortexActiveConn._flushOutQueue();
            } else {
                window.__vortexActiveConn?.httpSend?.({ type: 'poll' });
            }
        }""")
    except Exception:
        pass

def fetch_json(url, data=None, timeout=35, retries=4):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    if data:
        headers["Content-Type"] = "application/json"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            print(f"[Retry {attempt+1}] fetch failed: {e}. Waiting 3s...", flush=True)
            time.sleep(3)

async def safe_goto(page, url, retries=3):
    for attempt in range(retries):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            return True
        except Exception as e:
            if attempt == retries - 1:
                raise
            print(f"[Retry {attempt+1}] goto failed: {e}. Waiting 2s...", flush=True)
            await asyncio.sleep(2.0)

async def wait_ready(page, timeout=30):
    for _ in range(int(timeout * 4)):
        try:
            d = await page.evaluate("() => window.vortexDebug ? window.vortexDebug() : null")
            if d and d.get("connection") == "online":
                return d
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return await page.evaluate("() => window.vortexDebug ? window.vortexDebug() : null")

async def wait_video_metadata(page, timeout=35):
    for _ in range(int(timeout * 4)):
        try:
            dur = await page.evaluate("""() => {
                const v = document.querySelector('video');
                return (v && Number.isFinite(v.duration) && v.duration > 100) ? v.duration : 0;
            }""")
            if dur > 100:
                return dur
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return 0

async def run_verification():
    print("=== Step 1: Preparing Direct Test Stream ===", flush=True)
    # Open-licensed public test stream (Sintel, Blender Foundation, CC-BY) played directly — no catalog resolving
    cat_res = {"provider": "hls", "streamType": "hls", "title": "Sintel", "url": "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8", "duration": 888, "mediaType": "movie"}
    
    media_title = cat_res.get("title", "Sintel")
    duration = float(cat_res.get("duration", 2880))
    stream_url = cat_res.get("url", "")
    print(f"Test Media: '{media_title}', Duration: {duration}s, Stream URL: {stream_url[:60]}...", flush=True)
    record("Direct Test Stream Ready", bool(stream_url and duration >= 600), f"title={media_title}, duration={duration}s")
    
    print("\n=== Step 2: Creating Live Room on https://watchlivo.online ===", flush=True)
    create_payload = json.dumps({
        "name": "Peer 4 Seek Suite",
        "creator": "Leader",
        "media": cat_res
    }).encode()
    create_res = fetch_json(f"{BASE}/api/rooms/create", data=create_payload)
    room_id = create_res["room"]["id"]
    creator_cid = create_res["clientId"]
    creator_token = create_res["clientToken"]
    print(f"Room Created: {room_id} (Host CID: {creator_cid})", flush=True)
    record("Room Created With Test Stream", bool(room_id), f"roomId={room_id}")

    print("\n=== Step 3: Launching 4 Live Peers (Leader + 3 Guests) ===", flush=True)
    async with async_playwright() as p:
        launch_args = [
            "--autoplay-policy=no-user-gesture-required",
            "--mute-audio",
            "--disable-gpu",
            "--disable-web-security",
        ]
        try:
            br = await p.chromium.launch(channel="chrome", headless=True, args=launch_args)
        except Exception:
            br = await p.chromium.launch(headless=True, args=launch_args)

        # Leader P1 Context with Session Tokens
        ctx1 = await br.new_context(viewport={"width": 1280, "height": 720}, locale="tr-TR")
        prof1 = json.dumps({"id": "uid-Leader", "name": "Leader", "color": "#00f5d4"})
        init1 = f"""
        localStorage.setItem('vortex_profile_v2', {json.dumps(prof1)});
        sessionStorage.setItem('vortex_cid', '{creator_cid}');
        sessionStorage.setItem('vortex_ct_{room_id}', '{creator_token}');
        sessionStorage.setItem('vortex_creator_{room_id}', '{creator_cid}');
        """
        await ctx1.add_init_script(init1)
        p1 = await ctx1.new_page()
        p1.errors = []
        p1.on("pageerror", lambda e: p1.errors.append(str(e)))

        print("Connecting Peer 1 (Leader)...", flush=True)
        await safe_goto(p1, f"{BASE}/#/mesh/{room_id}?new=1&cid={creator_cid}&r_tok={creator_token}")

        # Guest Contexts P2, P3, P4
        guest_configs = [
            ("Peer 2", "#f43f5e"),
            ("Peer 3", "#3b82f6"),
            ("Peer 4", "#a855f7")
        ]
        guest_pages = []
        for name, col in guest_configs:
            await asyncio.sleep(0.8)
            ctx = await br.new_context(viewport={"width": 1280, "height": 720}, locale="tr-TR")
            prof = json.dumps({"id": f"uid-{name}", "name": name, "color": col})
            await ctx.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof)});")
            pg = await ctx.new_page()
            pg.errors = []
            pg.on("pageerror", lambda e: pg.errors.append(str(e)))
            print(f"Connecting {name}...", flush=True)
            await safe_goto(pg, f"{BASE}/#/mesh/{room_id}")
            guest_pages.append(pg)

        p2, p3, p4 = guest_pages[0], guest_pages[1], guest_pages[2]
        all_peers = [p1, p2, p3, p4]

        # Wait until all 4 peers establish online state
        print("Waiting for all 4 peers to establish connection...", flush=True)
        d1, d2, d3, d4 = await asyncio.gather(
            wait_ready(p1, timeout=25),
            wait_ready(p2, timeout=25),
            wait_ready(p3, timeout=25),
            wait_ready(p4, timeout=25)
        )
        record("Peer 1 Connected as Leader", bool(d1 and d1.get("connection") == "online"), f"cid={d1.get('clientId') if d1 else None}")
        record("Peer 4 Connected to Room", bool(d4 and d4.get("connection") == "online"), f"cid={d4.get('clientId') if d4 else None}")

        print("\n=== Step 4: Synchronizing Mesh Room State (4 Peers) ===", flush=True)
        for _ in range(12):
            await asyncio.sleep(0.5)
            for pg in all_peers:
                await poll_page(pg)
            d1 = await dbg(p1)
            d4 = await dbg(p4)
            p_counts = [await pg.evaluate("() => window.vortexDebug ? window.vortexDebug().participants : 0") for pg in all_peers]
            if d1 and d4 and d1.get("isLeader") and not d4.get("isLeader") and any(c >= 4 for c in p_counts):
                break

        d1 = await dbg(p1)
        d4 = await dbg(p4)
        p_counts = [await pg.evaluate("() => window.vortexDebug ? window.vortexDebug().participants : 0") for pg in all_peers]
        print(f"Room Participants: {p_counts}", flush=True)
        record("All 4 Peers Active In Room", any(c >= 4 for c in p_counts), f"counts={p_counts}")
        record("Peer 1 is Leader & Peer 4 is Guest", bool(d1 and d1.get("isLeader") and d4 and not d4.get("isLeader")), f"d1.isLeader={d1.get('isLeader') if d1 else None}, d4.isLeader={d4.get('isLeader') if d4 else None}")

        print("\n=== Step 5: Waiting for HLS Metadata & Player Readiness ===", flush=True)
        durations = []
        for pg in all_peers:
            dur = await wait_video_metadata(pg, timeout=35)
            durations.append(dur)
        print(f"All 4 Video Durations Loaded: {[round(d, 1) for d in durations]}s", flush=True)
        record("Video Duration Ready (>800s)", durations[0] >= 800.0 and durations[3] >= 800.0, f"P1={durations[0]:.1f}s, P4={durations[3]:.1f}s")

        print("\n=== Step 6: Testing Jump to 10m (600.0s) on Test Stream ===", flush=True)
        TARGET_SEEK = 600.0  # 10 minutes = 600.0 seconds
        print(f"Leader executing seek/jump to {TARGET_SEEK}s (10m00s)...", flush=True)
        
        # Leader executes seek to 10 minutes
        await p1.evaluate(f"() => {{ window.vortexActions.seek({TARGET_SEEK}); if (window.__vortexActiveConn?.outQueue?.length) window.__vortexActiveConn._flushOutQueue(); }}")

        # Monitor convergence across all 4 peers
        print("Waiting for all peers to align to 10m...", flush=True)
        converged = False
        t_final = None
        for tick in range(30):
            await asyncio.sleep(0.5)
            for pg in all_peers:
                await poll_page(pg)
            times = [await pg.evaluate("() => window.vortexDebug ? window.vortexDebug().time : null") for pg in all_peers]
            if all(t is not None for t in times):
                diff_p4_p1 = abs(times[3] - times[0])
                span = max(times) - min(times)
                if tick % 2 == 0 or diff_p4_p1 < 0.35:
                    print(f"t={tick*0.5:.1f}s: P1={times[0]:.2f}s, P2={times[1]:.2f}s, P3={times[2]:.2f}s, P4={times[3]:.2f}s | diff(P4-P1)={diff_p4_p1*1000:.0f}ms, span={span*1000:.0f}ms", flush=True)
                if abs(times[3] - TARGET_SEEK) < 8.0 and diff_p4_p1 < 0.35:
                    converged = True
                    t_final = times
                    print(f"CONVERGED at t={tick*0.5:.1f}s! P1={times[0]:.2f}s, P4={times[3]:.2f}s (Δ={diff_p4_p1*1000:.0f}ms, span={span*1000:.0f}ms)", flush=True)
                    break

        if not t_final:
            times = [await pg.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") for pg in all_peers]
            t_final = times

        p4_jumped = abs(t_final[3] - TARGET_SEEK) < 8.0
        p4_leader_drift = abs(t_final[3] - t_final[0])
        max_peer_span = max(t_final) - min(t_final)

        record("Peer 4 Jumped to ~10m (600s)", p4_jumped, f"P4 time={t_final[3]:.2f}s (target={TARGET_SEEK}s)")
        record("Peer 4 to Leader Alignment |Δ| < 350ms", p4_leader_drift < 0.35, f"|P4 - P1| = {p4_leader_drift*1000:.0f}ms")
        record("All 4 Peers Aligned Post-Seek (|max Δ| < 400ms)", max_peer_span < 0.40, f"times={[round(t, 2) for t in t_final]}, span={max_peer_span*1000:.0f}ms")

        # Save screenshots
        shot_leader = os.path.join(SHOTS_DIR, "01_leader_after_10m_seek.png")
        shot_peer4 = os.path.join(SHOTS_DIR, "02_peer4_after_10m_seek.png")
        await p1.screenshot(path=shot_leader)
        await p4.screenshot(path=shot_peer4)
        print(f"Screenshots saved: {shot_leader}, {shot_peer4}", flush=True)

        print("\n=== Step 7: Testing Scrubbing Synchronization (600s -> 615s -> 630s) ===", flush=True)
        # Scrubbing step 1: scrub forward to 615s (10m15s)
        SCRUB_STEP_1 = 615.0
        print(f"Scrubbing forward to {SCRUB_STEP_1}s (10m15s)...", flush=True)
        await p1.evaluate(f"() => {{ window.vortexActions.seek({SCRUB_STEP_1}); if (window.__vortexActiveConn?.outQueue?.length) window.__vortexActiveConn._flushOutQueue(); }}")
        p4_t1, p1_t1 = 0, 0
        for _ in range(16):
            await asyncio.sleep(0.5)
            for pg in all_peers:
                await poll_page(pg)
            p1_t1 = await p1.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
            p4_t1 = await p4.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
            if abs(p4_t1 - SCRUB_STEP_1) < 6.0 and abs(p4_t1 - p1_t1) < 0.35:
                break
        record("Scrub Step 1 (615s) Propagates to Peer 4", abs(p4_t1 - SCRUB_STEP_1) < 8.0, f"P4={p4_t1:.2f}s, P1={p1_t1:.2f}s")
        record("Peer 4 In-Sync at 615s (|Δ| < 350ms)", abs(p4_t1 - p1_t1) < 0.35, f"|P4 - P1| = {abs(p4_t1 - p1_t1)*1000:.0f}ms")

        # Scrubbing step 2: scrub forward to 630s (10m30s)
        SCRUB_STEP_2 = 630.0
        print(f"Scrubbing forward to {SCRUB_STEP_2}s (10m30s)...", flush=True)
        await p1.evaluate(f"() => {{ window.vortexActions.seek({SCRUB_STEP_2}); if (window.__vortexActiveConn?.outQueue?.length) window.__vortexActiveConn._flushOutQueue(); }}")
        p4_t2, p1_t2 = 0, 0
        for _ in range(16):
            await asyncio.sleep(0.5)
            for pg in all_peers:
                await poll_page(pg)
            p1_t2 = await p1.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
            p4_t2 = await p4.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
            if abs(p4_t2 - SCRUB_STEP_2) < 6.0 and abs(p4_t2 - p1_t2) < 0.35:
                break
        record("Scrub Step 2 (630s) Propagates to Peer 4", abs(p4_t2 - SCRUB_STEP_2) < 8.0, f"P4={p4_t2:.2f}s, P1={p1_t2:.2f}s")
        record("Peer 4 In-Sync at 630s (|Δ| < 350ms)", abs(p4_t2 - p1_t2) < 0.35, f"|P4 - P1| = {abs(p4_t2 - p1_t2)*1000:.0f}ms")

        shot_p4_scrub = os.path.join(SHOTS_DIR, "03_peer4_after_scrub_630s.png")
        await p4.screenshot(path=shot_p4_scrub)

        # Step 7C: Guest Peer 4 timeline scrub protection
        print("Testing Guest Peer 4 timeline scrub restriction...", flush=True)
        before_t = await p1.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
        await p4.evaluate("() => window.vortexActions.seek(150)")
        await asyncio.sleep(1.0)
        after_t = await p1.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
        guest_blocked = abs(after_t - before_t) < 3.0
        record("Guest Peer 4 Unauthorized Seek Blocked", guest_blocked, f"Leader time moved {after_t - before_t:.2f}s")

        print("\n=== Step 8: Checking Zero Page/Console Errors ===", flush=True)
        all_errs = p1.errors + p2.errors + p3.errors + p4.errors
        record("Zero Uncaught Page Errors Across All 4 Peers", len(all_errs) == 0, "; ".join(all_errs[:2]) if all_errs else "Clean")

        await br.close()

    passed_count = sum(1 for r in test_results if r["passed"])
    total_count = len(test_results)
    print(f"\n================ SUMMARY: {passed_count}/{total_count} PASSED ================", flush=True)
    return passed_count == total_count

if __name__ == "__main__":
    ok = asyncio.run(run_verification())
    sys.exit(0 if ok else 1)
