
import asyncio, json, urllib.request
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

async def test():
    cat_url = f"{BASE}/api/rave/resolve-catalog?provider=netflix&title=Stranger+Things&mediaType=tv&season=1&episode=1"
    req = urllib.request.Request(cat_url, headers={"User-Agent": "Mozilla/5.0"})
    cat_res = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    
    body = json.dumps({"name": "SeekProbe", "creator": "Leader", "media": cat_res}).encode()
    req = urllib.request.Request(f"{BASE}/api/rooms/create", data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    res = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    room_id = res["room"]["id"]
    cid = res["clientId"]
    tok = res["clientToken"]
    print("Room:", room_id, "CID:", cid)
    
    async with async_playwright() as p:
        br = await p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-web-security"])
        
        # P1 (Leader)
        ctx1 = await br.new_context()
        prof1 = json.dumps({"id": "uid-Leader", "name": "Leader", "color": "#00f5d4"})
        await ctx1.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof1)});")
        p1 = await ctx1.new_page()
        await p1.goto(f"{BASE}/#/mesh/{room_id}?new=1&cid={cid}&r_tok={tok}", wait_until="domcontentloaded")
        d1 = await wait_ready(p1)
        print("P1 ready, isLeader:", d1.get("isLeader"))
        
        # P2 (Guest)
        ctx2 = await br.new_context()
        prof2 = json.dumps({"id": "uid-Guest", "name": "Guest", "color": "#f43f5e"})
        await ctx2.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof2)});")
        p2 = await ctx2.new_page()
        await p2.goto(f"{BASE}/#/mesh/{room_id}", wait_until="domcontentloaded")
        d2 = await wait_ready(p2)
        print("P2 ready, isLeader:", d2.get("isLeader"))
        
        # Wait for both video durations loaded
        print("Waiting for video metadata...")
        for _ in range(40):
            await asyncio.sleep(0.5)
            dur1 = await p1.evaluate("() => { const v = document.querySelector('video'); return v && Number.isFinite(v.duration) && v.duration > 100 ? v.duration : 0; }")
            dur2 = await p2.evaluate("() => { const v = document.querySelector('video'); return v && Number.isFinite(v.duration) && v.duration > 100 ? v.duration : 0; }")
            if dur1 > 100 and dur2 > 100:
                print(f"Durations loaded: P1={dur1:.1f}s, P2={dur2:.1f}s")
                break
                
        d1 = await p1.evaluate("() => window.vortexDebug()")
        d2 = await p2.evaluate("() => window.vortexDebug()")
        print("Before seek: P1 time:", d1.get("time"), "P2 time:", d2.get("time"))
        
        print("Leader seeking to 600.0s...")
        await p1.evaluate("() => { window.vortexActions.seek(600.0); if (window.__vortexActiveConn?.outQueue?.length) window.__vortexActiveConn._flushOutQueue(); }")
        
        print("Waiting for unbuffered HLS segment convergence...")
        for tick in range(25):
            await asyncio.sleep(0.5)
            await p1.evaluate("() => window.__vortexActiveConn?.httpSend?.({ type: 'poll' })")
            await p2.evaluate("() => window.__vortexActiveConn?.httpSend?.({ type: 'poll' })")
            d1 = await p1.evaluate("() => window.vortexDebug()")
            d2 = await p2.evaluate("() => window.vortexDebug()")
            t1 = d1.get("time") or 0
            t2 = d2.get("time") or 0
            diff = abs(t1 - t2)
            if tick % 4 == 0 or diff < 0.3:
                print(f"t={tick*0.5:.1f}s: P1={t1:.2f}s, P2={t2:.2f}s, diff={diff*1000:.0f}ms")
            if abs(t2 - 600.0) < 5.0 and diff < 0.3:
                print("SUCCESSFULLY CONVERGED TO 10m!")
                break
                
        await br.close()

asyncio.run(test())
