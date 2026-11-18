
import asyncio, json, urllib.request
from playwright.async_api import async_playwright

BASE = "https://watchlivo.online"

async def test():
    req = urllib.request.Request(f"{BASE}/api/rooms/create", data=json.dumps({"name": "NewParamTest", "creator": "Leader"}).encode(), headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    res = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    room_id = res["room"]["id"]
    cid = res["clientId"]
    tok = res["clientToken"]
    print("Room:", room_id, "CID:", cid)
    
    async with async_playwright() as p:
        br = await p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-web-security"])
        ctx = await br.new_context()
        prof = json.dumps({"id": "uid-Leader", "name": "Leader", "color": "#00f5d4"})
        await ctx.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof)});")
        page = await ctx.new_page()
        nav_url = f"{BASE}/#/mesh/{room_id}?new=1&cid={cid}&r_tok={tok}"
        print("Navigating to:", nav_url)
        await page.goto(nav_url, wait_until="domcontentloaded")
        
        for _ in range(20):
            await asyncio.sleep(0.5)
            d = await page.evaluate("() => window.vortexDebug ? window.vortexDebug() : null")
            if d and d.get("connection") == "online":
                print("Leader online! isLeader:", d.get("isLeader"), "cid:", d.get("clientId"))
                break
        await br.close()

asyncio.run(test())
