"""God's Eye E2E #2: in-room provider selection (Rave Search panel), play-mode rules, panels, YouTube sync."""
import asyncio, json, sys, pathlib, urllib.request
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
SHOTS = pathlib.Path(r"C:\Users\pc\.gemini\antigravity\brain\0bcd2c58-ffcb-4ebe-873b-242386b0f07a\scratch\shots")
SHOTS.mkdir(parents=True, exist_ok=True)
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def open_user(br, name, color, room):
    ctx = await br.new_context(viewport={"width": 1440, "height": 860}, locale="tr-TR")
    await ctx.add_init_script(f"localStorage.setItem('vortex_profile_v2', JSON.stringify({{id:'uid-{name}',name:'{name}',color:'{color}'}}))")
    page = await ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    await page.goto(f"{BASE}/#/mesh/{room}", wait_until="domcontentloaded")
    for _ in range(60):
        d = await page.evaluate("window.vortexDebug ? window.vortexDebug() : null")
        if d and d["connection"] == "online" and d["participants"] >= 1:
            break
        await asyncio.sleep(0.25)
    return page


async def dbg(p):
    return await p.evaluate("window.vortexDebug()")


async def wait_for(fn, timeout=20):
    for _ in range(int(timeout * 4)):
        if await fn():
            return True
        await asyncio.sleep(0.25)
    return False


async def main():
    body = json.dumps({"name": "Seçim Testi", "creator": "QA"}).encode()
    room = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + "/api/rooms/create", data=body, headers={"Content-Type": "application/json"})).read())["room"]["id"]
    print("room:", room)
    async with async_playwright() as p:
        br = await p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required", "--mute-audio"])
        A = await open_user(br, "Lider", "#00f5d4", room)
        B = await open_user(br, "Konuk", "#f43f5e", room)
        await wait_for(lambda: B.evaluate("window.vortexDebug()?.participants >= 2 && !window.vortexDebug()?.isLeader"), 8)
        check("empty room shows pre-message", await A.locator(".stage-empty:not(.hidden)").count() == 1)
        await B.click("#nav-search-video")
        check("guest Video Ara blocked in Liderin Seçimi", await B.locator(".popup").count() == 1)
        await B.click(".popup .btn")
        await A.click("#nav-search-video")
        check("left Search panel opens (zero MASAÜSTÜ locks)", await A.locator(".mesh-layout.has-left").count() == 1 and await A.locator(".panel-left .provider-tile").count() >= 10 and await A.locator(".panel-left .provider-tile .lock").count() == 0)
        await A.screenshot(path=str(SHOTS / "10_mesh_search_panel.png"))
        await A.click('.panel-left .provider-tile[data-provider="netflix"]')
        ok_nfx = await wait_for(lambda: A.locator(".panel-left .poster").count(), 15)
        await wait_for(lambda: A.evaluate("(() => { const im = document.querySelector('.panel-left .poster img'); return !!(im && im.complete && im.naturalWidth > 0); })()"), 8)
        bad_ui = await A.evaluate("/(Sunucu 1|Sunucu 2|W2G Yan Pencere|Sekme Yansıt)/i.test(document.body.innerText)")
        check("Netflix opens clean Web Catalog (no Sunucu/W2G/Tab share clutter)", ok_nfx and not bad_ui, f"{await A.locator('.panel-left .poster').count()} posters")
        await A.screenshot(path=str(SHOTS / "14_mesh_netflix_catalog.png"))
        await A.locator(".panel-left .poster").first.click()
        await asyncio.sleep(0.3)
        check("Netflix poster click opens NO popup modal", await A.locator(".popup").count() == 0)
        ok_nfx_play = await wait_for(lambda: B.evaluate("(window.vortexDebug().key||'').startsWith('netflix|')"), 20)
        check("Netflix poster resolves & plays directly in room", ok_nfx_play)
        await wait_for(lambda: B.evaluate("window.vortexDebug().time > 1.5"), 25)
        await wait_for(lambda: B.evaluate("Math.abs(window.vortexDebug().drift || 9) < 0.35"), 10)
        nda, ndb = await dbg(A), await dbg(B)
        nd = abs((nda["time"] or 0) - (ndb["time"] or 0))
        host_kids = await A.evaluate("document.querySelectorAll('.player-host > *').length")
        bad_stage = await A.evaluate("/(Sunucu 1|W2G Yan Pencere|Sekme Yansıt)/i.test(document.body.innerText)")
        check("Netflix playback sync |Δ| < 400ms & clean stage DOM", nd < 0.4 and host_kids == 1 and not bad_stage, f"{nd*1000:.0f}ms kids={host_kids}")
        await A.screenshot(path=str(SHOTS / "15_mesh_netflix_playing.png"))
        await A.click("#nav-search-video")
        await A.click('.panel-left .provider-tile[data-provider="youtube"]') if await A.locator('.panel-left .provider-tile[data-provider="youtube"]').count() else None
        ok = await wait_for(lambda: A.locator(".panel-left .vcard").count(), 20)
        await wait_for(lambda: A.evaluate("(() => { const im = document.querySelector('.panel-left .vcard-thumb > img:not(.vcard-prov)'); return !!(im && im.complete && im.naturalWidth > 0); })()"), 8)
        check("YouTube results inside room panel", ok, f"{await A.locator('.panel-left .vcard').count()} cards")
        await A.screenshot(path=str(SHOTS / "11_mesh_youtube_selection.png"))
        await A.locator(".panel-left .vcard").first.click()
        ok = await wait_for(lambda: B.evaluate("(window.vortexDebug().key||'').startsWith('youtube|')"), 15)
        check("leader pick plays for everyone", ok)
        check("Search panel collapses after pick (Rave)", await A.locator(".mesh-layout.has-left").count() == 0)
        await wait_for(lambda: B.evaluate("window.vortexDebug().time > 2"), 25)
        await wait_for(lambda: B.evaluate("Math.abs(window.vortexDebug().drift || 9) < 0.35"), 10)
        da, db = await dbg(A), await dbg(B)
        d = abs((da["time"] or 0) - (db["time"] or 0))
        check("YouTube sync |Δ| < 400ms", d < 0.4, f"{d*1000:.0f}ms modes={da['syncMode']}/{db['syncMode']}")
        await A.screenshot(path=str(SHOTS / "12_mesh_youtube_playing.png"))
        await A.click('.navbar-left [aria-label="Ayarlar"]')
        await A.click('.panel-left .seg button[data-value="vote"]')
        ok = await wait_for(lambda: B.evaluate("window.vortexDebug().playMode === 'vote'"), 6)
        check("leader switches to Oylayalım", ok)
        await B.click("#nav-search-video")
        await B.click('.panel-left .provider-tile[data-provider="youtube"]')
        await wait_for(lambda: B.locator(".panel-left .vcard").count(), 20)
        await B.locator(".panel-left .vcard").nth(2).click()
        ok = await wait_for(lambda: A.evaluate("window.vortexDebug().queue === 1"), 10)
        check("guest pick goes to vote queue", ok)
        await A.click('.navbar-right [aria-label="Oylama"]')
        check("Vote panel lists queued video", await A.locator(".panel-right .vote-card").count() == 1)
        await A.click('.navbar-right [aria-label="Katılımcılar"]')
        check("Participants panel lists 2 ravers with crown", await A.locator(".panel-right .raver").count() == 2 and await A.locator(".panel-right .crown").count() == 1)
        await A.screenshot(path=str(SHOTS / "13_mesh_panels.png"))
        await A.locator('.panel-right .raver-actions button[data-tip="Lider yap"]').first.click()
        ok = await wait_for(lambda: B.evaluate("window.vortexDebug().isLeader"), 6)
        check("leader transfer works", ok)
        await A.goto(f"{BASE}/#/", wait_until="domcontentloaded")
        await wait_for(lambda: A.locator(".meshthumb").count(), 8)
        check("Home Lobby renders MeshThumb pill card", await A.locator(".meshthumb").count() >= 1)
        await A.screenshot(path=str(SHOTS / "09_home_vortex.png"))
        errs = A.errors + B.errors
        check("no uncaught page errors", not errs, "; ".join(errs[:3]))
        await br.close()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


asyncio.run(main())
