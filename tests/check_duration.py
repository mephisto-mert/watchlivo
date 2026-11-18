
import asyncio, json, urllib.request
from playwright.async_api import async_playwright

BASE = "https://watchlivo.online"

async def test():
    # Open-licensed public test stream (Sintel, Blender Foundation, CC-BY) played directly — no catalog resolving
    cat_res = {"provider": "hls", "streamType": "hls", "title": "Sintel", "url": "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8", "duration": 888, "mediaType": "movie"}
    print("Catalog Duration:", cat_res.get("duration"))
    
    body = json.dumps({"name": "DurTest", "creator": "Leader", "media": cat_res}).encode()
    req = urllib.request.Request(f"{BASE}/api/rooms/create", data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    room_id = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())["room"]["id"]
    
    async with async_playwright() as p:
        br = await p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-web-security"])
        ctx = await br.new_context()
        prof = json.dumps({"id": "uid-Leader", "name": "Leader", "color": "#00f5d4"})
        await ctx.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof)});")
        page = await ctx.new_page()
        await page.goto(f"{BASE}/#/mesh/{room_id}", wait_until="domcontentloaded")
        
        for _ in range(20):
            await asyncio.sleep(1.0)
            dur_info = await page.evaluate("""() => {
                const v = document.querySelector('video');
                return {
                    videoDuration: v ? v.duration : null,
                    videoReadyState: v ? v.readyState : null,
                    videoSeekable: v && v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : null,
                    stateMediaDuration: window.vortexDebug?.() ? window.__vortexActiveConn?.lastRoom?.media?.duration : null
                };
            }""")
            print("Dur info:", dur_info)
            if dur_info.get("videoDuration") and dur_info.get("videoDuration") > 50:
                break
        await br.close()

asyncio.run(test())
