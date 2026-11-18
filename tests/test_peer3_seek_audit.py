import asyncio
import json
import os
import sys
import time
import urllib.request
from playwright.async_api import async_playwright

BASE = "https://watchlivo.online"

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

async def wait_video_ready(page, timeout=35):
    for _ in range(int(timeout * 4)):
        try:
            dur = await page.evaluate('''() => {
                const v = document.querySelector('video');
                return (v && Number.isFinite(v.duration) && v.duration > 100) ? v.duration : 0;
            }''')
            if dur > 100:
                return dur
        except Exception:
            pass
        await asyncio.sleep(0.25)
    return 0

async def audit():
    print("=== Subagent 11: Peer 3 Latency & Seek Audit ===", flush=True)
    # Open-licensed public test stream (Sintel, Blender Foundation, CC-BY) played directly — no catalog resolving
    cat_res = {"provider": "hls", "streamType": "hls", "title": "Sintel", "url": "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8", "duration": 888, "mediaType": "movie"}
    
    body = json.dumps({"name": "Peer3_SeekAudit", "creator": "Leader", "media": cat_res}).encode()
    req = urllib.request.Request(f"{BASE}/api/rooms/create", data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    res = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    room_id = res["room"]["id"]
    cid = res["clientId"]
    tok = res["clientToken"]
    print(f"Room Created: {room_id}, Host CID: {cid}", flush=True)

    async with async_playwright() as p:
        br = await p.chromium.launch(channel="chrome", headless=True, args=[
            "--autoplay-policy=no-user-gesture-required",
            "--mute-audio",
            "--disable-web-security"
        ])
        
        # P1 (Leader)
        ctx1 = await br.new_context()
        prof1 = json.dumps({"id": "uid-Leader", "name": "Leader", "color": "#00f5d4"})
        await ctx1.add_init_script(f'''
        localStorage.setItem('vortex_profile_v2', {json.dumps(prof1)});
        sessionStorage.setItem('vortex_cid', '{cid}');
        sessionStorage.setItem('vortex_ct_{room_id}', '{tok}');
        sessionStorage.setItem('vortex_creator_{room_id}', '{cid}');
        ''')
        p1 = await ctx1.new_page()
        
        # P2 (Normal Guest)
        ctx2 = await br.new_context()
        prof2 = json.dumps({"id": "uid-Peer2", "name": "Peer 2", "color": "#f43f5e"})
        await ctx2.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof2)});")
        p2 = await ctx2.new_page()

        # P3 (High Latency Spike Guest)
        ctx3 = await br.new_context()
        prof3 = json.dumps({"id": "uid-Peer3", "name": "Peer 3", "color": "#3b82f6"})
        await ctx3.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof3)});")
        p3 = await ctx3.new_page()

        # Connect all 3
        print("Connecting P1 (Leader), P2 (Guest), P3 (Audited Guest)...", flush=True)
        await p1.goto(f"{BASE}/#/mesh/{room_id}?new=1&cid={cid}&r_tok={tok}", wait_until="domcontentloaded")
        await p2.goto(f"{BASE}/#/mesh/{room_id}", wait_until="domcontentloaded")
        await p3.goto(f"{BASE}/#/mesh/{room_id}", wait_until="domcontentloaded")

        d1 = await wait_ready(p1)
        d2 = await wait_ready(p2)
        d3 = await wait_ready(p3)
        print(f"Peers Online: P1 isLeader={d1.get('isLeader')}, P2 isLeader={d2.get('isLeader')}, P3 isLeader={d3.get('isLeader')}", flush=True)

        print("Waiting for media readiness...", flush=True)
        dur1 = await wait_video_ready(p1)
        dur2 = await wait_video_ready(p2)
        dur3 = await wait_video_ready(p3)
        print(f"Durations loaded: P1={dur1:.1f}s, P2={dur2:.1f}s, P3={dur3:.1f}s", flush=True)

        # Hook WebSocket frame counters on Leader and Peer 3
        await p1.evaluate('''() => {
            window.__ws_sent = [];
            const origSend = WebSocket.prototype.send;
            WebSocket.prototype.send = function(data) {
                try {
                    const parsed = JSON.parse(data);
                    window.__ws_sent.push({ type: parsed.type, time: performance.now(), data: parsed });
                } catch(e) {}
                return origSend.apply(this, arguments);
            };
        }''')

        await p3.evaluate('''() => {
            window.__seek_events = [];
            const v = document.querySelector('video');
            if (v) {
                v.addEventListener('seeking', () => {
                    window.__seek_events.push({ event: 'seeking', target: v.currentTime, time: performance.now() });
                });
                v.addEventListener('seeked', () => {
                    window.__seek_events.push({ event: 'seeked', target: v.currentTime, time: performance.now() });
                });
            }
        }''')

        # TEST 1: Rapid Seek Burst (5 seeks within 100ms)
        print("\n--- Test 1: Rapid Seek Burst (5 seeks: 100s, 110s, 120s, 130s, 140s) ---", flush=True)
        burst_targets = [100.0, 110.0, 120.0, 130.0, 140.0]
        for t in burst_targets:
            await p1.evaluate(f"() => window.vortexActions.seek({t})")
            await asyncio.sleep(0.02)

        sent_msgs = await p1.evaluate("() => window.__ws_sent") or []
        seek_msgs = [m for m in sent_msgs if m.get("type") == "seek"]
        print(f"Leader dispatched {len(seek_msgs)} seek WebSocket frames for 5 burst calls. Throttle/Debounce: {'MISSING' if len(seek_msgs) == 5 else 'ACTIVE'}", flush=True)

        await asyncio.sleep(3.0)

        p3_seeks = await p3.evaluate("() => window.__seek_events") or []
        print(f"Peer 3 video element seeking events count: {len(p3_seeks)}", flush=True)
        for ev in p3_seeks:
            print(f"   [P3 video] {ev['event']} at {ev['target']:.1f}s (t={ev['time']:.0f}ms)", flush=True)

        # TEST 2: Latency Spike on Peer 3 (Simulate 1200ms latency spike via CDP)
        print("\n--- Test 2: Latency Spike Simulation on Peer 3 (1200ms latency) ---", flush=True)
        cdp_p3 = await ctx3.new_cdp_session(p3)
        await cdp_p3.send("Network.emulateNetworkConditions", {
            "offline": False,
            "latency": 1200,
            "downloadThroughput": 500 * 1024,
            "uploadThroughput": 200 * 1024
        })
        print("Emulating 1200ms latency spike on Peer 3...", flush=True)

        await p3.evaluate("() => { window.__seek_events = []; }")

        TARGET_SEEK_2 = 500.0
        print(f"Leader seeking to {TARGET_SEEK_2}s during Peer 3 latency spike...", flush=True)
        await p1.evaluate(f"() => window.vortexActions.seek({TARGET_SEEK_2})")

        for tick in range(16):
            await asyncio.sleep(0.5)
            t1 = await p1.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
            t3 = await p3.evaluate("() => window.vortexDebug ? window.vortexDebug().time : 0") or 0
            p3_status = await p3.evaluate("() => window.vortexDebug ? window.vortexDebug().sync : null") or {}
            mode = p3_status.get("mode")
            if tick % 2 == 0 or abs(t1 - t3) < 0.5:
                print(f"t={tick*0.5:.1f}s: Leader={t1:.2f}s, Peer3={t3:.2f}s | diff={abs(t1-t3)*1000:.0f}ms | P3 mode={mode}", flush=True)
            if abs(t3 - TARGET_SEEK_2) < 5.0 and abs(t1 - t3) < 0.35:
                print(f"CONVERGED at t={tick*0.5:.1f}s!", flush=True)
                break

        p3_seeks_post = await p3.evaluate("() => window.__seek_events") or []
        seeking_count = sum(1 for e in p3_seeks_post if e.get("event") == "seeking")
        print(f"Peer 3 performed {seeking_count} separate seeking operations for 1 leader seek command.", flush=True)

        await cdp_p3.send("Network.emulateNetworkConditions", {
            "offline": False,
            "latency": 0,
            "downloadThroughput": -1,
            "uploadThroughput": -1
        })

        await br.close()

if __name__ == "__main__":
    asyncio.run(audit())
