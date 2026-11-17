import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
SHOTS_DIR = os.path.join(os.path.dirname(__file__), "shots_peer2_mobile")
os.makedirs(SHOTS_DIR, exist_ok=True)

test_results = []

def record(name, passed, detail=""):
    test_results.append({"name": name, "passed": bool(passed), "detail": str(detail)})
    mark = "PASS" if passed else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail else ""), flush=True)

def fetch_json(url, data=None, timeout=35):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())

async def run_mobile_test():
    print("=== Step 0: Starting Local Watchlivo Server ===", flush=True)
    server_proc = subprocess.Popen(
        ["python", "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=r"c:\Users\pc\Documents\projelerim\watchlivo"
    )
    time.sleep(2.5)

    try:
        print("=== Step 1: Resolving Media & Creating Room ===", flush=True)
        cat_url = f"{BASE}/api/rave/resolve-catalog?provider=netflix&title=Stranger+Things&mediaType=tv&season=1&episode=1"
        cat_res = fetch_json(cat_url)
        media_title = cat_res.get("title", "Stranger Things")
        duration = float(cat_res.get("duration", 2880))
        print(f"Media Resolved: {media_title}, duration={duration}s", flush=True)
        
        create_payload = json.dumps({
            "name": "Mobile Peer 2 Test Suite",
            "creator": "Leader_Desktop",
            "media": cat_res
        }).encode()
        create_res = fetch_json(f"{BASE}/api/rooms/create", data=create_payload)
        room_id = create_res["room"]["id"]
        creator_cid = create_res["clientId"]
        creator_token = create_res["clientToken"]
        print(f"Room Created: {room_id}", flush=True)

        async with async_playwright() as p:
            print("=== Step 2: Launching Desktop Leader (Peer 1) ===", flush=True)
            br_leader = await p.chromium.launch(
                channel="chrome",
                headless=True,
                args=["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-gpu"]
            )
            ctx_leader = await br_leader.new_context(viewport={"width": 1280, "height": 720})
            prof1 = json.dumps({"id": "uid-Leader", "name": "Leader", "color": "#00f5d4"})
            await ctx_leader.add_init_script(f"""
                localStorage.setItem('vortex_profile_v2', {json.dumps(prof1)});
                sessionStorage.setItem('vortex_cid', '{creator_cid}');
                sessionStorage.setItem('vortex_ct_{room_id}', '{creator_token}');
                sessionStorage.setItem('vortex_creator_{room_id}', '{creator_cid}');
            """)
            p_leader = await ctx_leader.new_page()
            await p_leader.goto(f"{BASE}/#/mesh/{room_id}?new=1&cid={creator_cid}&r_tok={creator_token}", wait_until="domcontentloaded")
            await p_leader.wait_for_selector(".mesh-layout", timeout=15000)
            print("Leader room mounted successfully!", flush=True)
            await asyncio.sleep(2.0)

            print("=== Step 3: Launching Mobile Peer 2 (Pixel 7) ===", flush=True)
            br_mobile = await p.chromium.launch(channel="chrome", headless=True, args=["--disable-gpu"])
            mobile_device = p.devices["Pixel 7"]
            ctx_mobile = await br_mobile.new_context(**mobile_device, locale="tr-TR")
            prof2 = json.dumps({"id": "uid-MobilePeer2", "name": "MobileGuest", "color": "#ff3b5c"})
            await ctx_mobile.add_init_script(f"""
                localStorage.setItem('vortex_profile_v2', {json.dumps(prof2)});
            """)
            p_mobile = await ctx_mobile.new_page()
            page_errors = []
            p_mobile.on("pageerror", lambda e: page_errors.append(str(e)))
            console_logs = []
            p_mobile.on("console", lambda m: console_logs.append(f"[{m.type}] {m.text}"))

            await p_mobile.goto(f"{BASE}/#/mesh/{room_id}", wait_until="domcontentloaded")
            await p_mobile.wait_for_selector(".mesh-layout", timeout=15000)
            print("Mobile client room mounted successfully!", flush=True)
            await asyncio.sleep(3.0)

            # 1. Inspect Layout
            layout_info = await p_mobile.evaluate("""() => {
                const layout = document.querySelector('.mesh-layout');
                const videoChat = document.querySelector('.video-chat');
                const resizeHandle = document.querySelector('.resize-handle');
                const cs = (el) => el ? window.getComputedStyle(el) : null;
                return {
                    layoutFlexDir: cs(layout)?.flexDirection,
                    videoChatLayoutDirVar: cs(videoChat)?.getPropertyValue('--layout-direction')?.trim(),
                    resizeHandleDisplay: cs(resizeHandle)?.display
                };
            }""")
            is_col = (layout_info["videoChatLayoutDirVar"] == "column" or layout_info["layoutFlexDir"] == "column")
            record("Mobile Layout Stacks Column (Video over Chat)", is_col, str(layout_info))
            record("Resize Handle Hidden on Mobile", layout_info["resizeHandleDisplay"] == "none", str(layout_info["resizeHandleDisplay"]))

            # 2. Inspect Touch Controls & Timeline
            touch_info = await p_mobile.evaluate("""() => {
                const timeline = document.querySelector('.timeline');
                const cs = (el) => el ? window.getComputedStyle(el) : null;
                return {
                    touchAction: cs(timeline)?.touchAction,
                    height: timeline?.getBoundingClientRect()?.height
                };
            }""")
            record("Timeline CSS touch-action is none", touch_info["touchAction"] == "none", str(touch_info))

            # 3. Autoplay Restrictions & Unmute
            auto_info = await p_mobile.evaluate("""() => {
                const v = document.querySelector('video');
                const host = window.__kinoxHost;
                const unmuteBtn = document.querySelector('#ctl-unmute');
                return {
                    videoPaused: v ? v.paused : null,
                    videoMuted: v ? v.muted : null,
                    hostAutoplayBlocked: host ? host.autoplayBlocked : null,
                    unmuteVisible: unmuteBtn && !unmuteBtn.classList.contains('hidden')
                };
            }""")
            record("Autoplay Policy Caught by PlayerHost", auto_info["hostAutoplayBlocked"] is True or auto_info["videoMuted"] is True or auto_info["unmuteVisible"] is True, str(auto_info))

            # Tap Video to Unlock
            await p_mobile.tap(".video-frame")
            await asyncio.sleep(1.0)
            after_tap = await p_mobile.evaluate("""() => {
                const v = document.querySelector('video');
                const host = window.__kinoxHost;
                return {
                    videoMuted: v ? v.muted : null,
                    hostUserUnlocked: host ? host.userUnlocked : null
                };
            }""")
            record("User Tap Unlocks Audio on Mobile", after_tap.get("hostUserUnlocked") is True or after_tap.get("videoMuted") is False, str(after_tap))

            # 4. PiP Methods
            pip_info = await p_mobile.evaluate("""() => {
                const host = window.__kinoxHost;
                return {
                    hasTogglePiP: typeof host?.togglePiP === 'function',
                    hasIsPiP: typeof host?.isPiP === 'function'
                };
            }""")
            record("Host defines togglePiP()", pip_info["hasTogglePiP"], str(pip_info))
            record("Host defines isPiP()", pip_info["hasIsPiP"], str(pip_info))

            # 5. Background / Visibility State
            await p_mobile.evaluate("""() => {
                Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true });
                document.dispatchEvent(new Event('visibilitychange'));
            }""")
            await asyncio.sleep(1.5)
            bg_info = await p_mobile.evaluate("""() => {
                const v = document.querySelector('video');
                return { paused: v ? v.paused : null, time: v ? v.currentTime : null };
            }""")
            record("Background Playback Maintained when Hidden", bg_info["paused"] is False or bg_info["time"] > 0, str(bg_info))

            await p_mobile.screenshot(path=os.path.join(SHOTS_DIR, "mobile_peer2_view.png"))

            if page_errors:
                print("Page Errors:", page_errors)
            record("Zero Uncaught Page Errors on Mobile Client", len(page_errors) == 0, f"errors={len(page_errors)}")

            await br_mobile.close()
            await br_leader.close()
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=4)
        except Exception:
            server_proc.kill()

    print("\n================ FINAL TEST SUMMARY ================")
    for r in test_results:
        print(f"[{'PASS' if r['passed'] else 'FAIL'}] {r['name']}: {r['detail']}")

if __name__ == "__main__":
    asyncio.run(run_mobile_test())