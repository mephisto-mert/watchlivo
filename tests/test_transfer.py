
import asyncio, json, urllib.request
from playwright.async_api import async_playwright

BASE = "https://watchlivo.online"

async def test():
    req = urllib.request.Request(f"{BASE}/api/rooms/create", data=json.dumps({"name": "LeaderTest", "creator": "Leader"}).encode(), headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    res = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    room_id = res["room"]["id"]
    creator_cid = res["clientId"]
    creator_token = res["clientToken"]
    print("Room:", room_id, "Creator CID:", creator_cid)
    
    async with async_playwright() as p:
        br = await p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-web-security"])
        
        # P1
        ctx1 = await br.new_context()
        prof1 = json.dumps({"id": "uid-Leader", "name": "Leader", "color": "#00f5d4"})
        await ctx1.add_init_script(f"""
            localStorage.setItem('vortex_profile_v2', {json.dumps(prof1)});
            sessionStorage.setItem('vortex_cid', '{creator_cid}');
            sessionStorage.setItem('vortex_ct_{room_id}', '{creator_token}');
            sessionStorage.setItem('vortex_creator_{room_id}', '{creator_cid}');
        """)
        p1 = await ctx1.new_page()
        await p1.goto(f"{BASE}/#/mesh/{room_id}", wait_until="domcontentloaded")
        await asyncio.sleep(2.0)
        
        # P2
        ctx2 = await br.new_context()
        prof2 = json.dumps({"id": "uid-Guest", "name": "Guest", "color": "#f43f5e"})
        await ctx2.add_init_script(f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof2)});")
        p2 = await ctx2.new_page()
        await p2.goto(f"{BASE}/#/mesh/{room_id}", wait_until="domcontentloaded")
        await asyncio.sleep(2.0)
        
        d1 = await p1.evaluate("() => window.vortexDebug()")
        d2 = await p2.evaluate("() => window.vortexDebug()")
        print("P1 dbg:", d1.get("clientId"), "isLeader:", d1.get("isLeader"))
        print("P2 dbg:", d2.get("clientId"), "isLeader:", d2.get("isLeader"))
        
        p2_cid = d2.get("clientId")
        print("Transferring host to P2 (cid:", p2_cid, ")...")
        transfer_res = await p1.evaluate(f"""async () => {{
            const res = await window.fetch('/api/rooms/{room_id}/sync', {{
                method: 'POST',
                headers: {{ 'Content-Type': 'application/json', 'X-Watchlivo-Transport': 'http-poll' }},
                body: JSON.stringify({{
                    type: 'host_action',
                    action: 'transfer_host',
                    targetId: '{p2_cid}',
                    clientId: '{creator_cid}',
                    clientToken: '{creator_token}'
                }})
            }});
            return await res.json();
        }}""")
        print("Transfer response:", transfer_res.get("ok"), transfer_res.get("room", {}).get("host_id"))
        
        await p2.evaluate("() => window.__vortexActiveConn?.httpSend?.({ type: 'poll' })")
        await asyncio.sleep(1.0)
        d2_after = await p2.evaluate("() => window.vortexDebug()")
        print("P2 after transfer:", d2_after.get("isLeader"))
        
        await br.close()

asyncio.run(test())
