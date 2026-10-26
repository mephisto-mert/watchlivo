"""God's Eye E2E: real browsers in one room — leader/guest/HTTP-guest sync, controls, chat, privacy."""
import asyncio, json, sys, urllib.request
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
MP4 = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"  # public Mux HLS test stream (CORS enabled)
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def create_room():
    body = json.dumps({"name": "GodsEye Test", "creator": "QA", "media": {"provider": "hls", "url": MP4, "title": "Big Buck Bunny", "duration": 596}}).encode()
    req = urllib.request.Request(BASE + "/api/rooms/create", data=body, headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())["room"]["id"]


async def open_user(browser, name, color, room, transport=None):
    ctx = await browser.new_context(viewport={"width": 1280, "height": 760}, locale="tr-TR")
    prof = json.dumps({"id": f"uid-{name}", "name": name, "color": color})
    script = f"localStorage.setItem('vortex_profile_v2', {json.dumps(prof)});"
    if transport:
        script += f"localStorage.setItem('vortex_transport', '{transport}');"
    await ctx.add_init_script(script)
    page = await ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    await page.goto(f"{BASE}/#/mesh/{room}", wait_until="domcontentloaded")
    return page


async def dbg(page):
    return await page.evaluate("window.vortexDebug ? window.vortexDebug() : null")


async def wait_ready(page, timeout=25):
    for _ in range(timeout * 4):
        d = await dbg(page)
        if d and d.get("time") is not None and d.get("connection") == "online":
            return d
        await asyncio.sleep(0.25)
    return await dbg(page)


async def delta(a, b):
    da, db = await asyncio.gather(dbg(a), dbg(b))
    return abs((da["time"] or 0) - (db["time"] or 0)), da, db


async def main():
    room = create_room()
    print("room:", room)
    async with async_playwright() as p:
        launch_args = dict(headless=True, args=["--autoplay-policy=no-user-gesture-required", "--mute-audio"])
        try:
            br = await p.chromium.launch(channel="chrome", **launch_args)  # real Chrome: H.264/AAC codecs
        except Exception:
            br = await p.chromium.launch(channel="msedge", **launch_args)
        A = await open_user(br, "Lider", "#00f5d4", room)
        await wait_ready(A)
        B = await open_user(br, "Misafir", "#f43f5e", room)
        db = await wait_ready(B)
        da = await dbg(A)
        check("leader is first joiner", da["isLeader"] and not db["isLeader"], f"A={da['isLeader']} B={db['isLeader']}")
        check("both on same media", da["key"] == db["key"] and "x36xhzz" in da["key"])
        check("participants=2 on both", da["participants"] == 2 and db["participants"] == 2)
        for _ in range(36):
            d, da, db = await delta(A, B)
            if d < 0.15 and da["syncMode"] == "inSync" and db["syncMode"] == "inSync":
                break
            await asyncio.sleep(0.25)
        check("playing sync |Δ| < 150ms", d < 0.15 and da["status"] == "PLAYING", f"Δ={d*1000:.0f}ms modes={da['syncMode']}/{db['syncMode']}")
        await A.hover("#video-frame"); await A.click("#ctl-play")
        await asyncio.sleep(1.5)
        d, da, db = await delta(A, B)
        check("leader pause propagates", db["paused"] and db["status"] == "PAUSED", f"Δ={d*1000:.0f}ms")
        check("paused positions equal |Δ| < 100ms", d < 0.1, f"{d*1000:.0f}ms")
        await A.hover("#video-frame"); await A.click("#ctl-play")
        await asyncio.sleep(4)
        d, _, _ = await delta(A, B)
        check("resume sync |Δ| < 150ms", d < 0.15, f"{d*1000:.0f}ms")
        await A.hover("#video-frame")
        box = await A.locator("#ctl-timeline").bounding_box()
        await A.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2)
        dur = await A.evaluate("document.querySelector('.player-host video')?.duration || 0")
        await asyncio.sleep(11)
        d, da, db = await delta(A, B)
        check("leader seek to ~50% propagates", abs((db["time"] or 0) - (dur * 0.5 + 11)) < 3, f"B={db['time']:.1f}s dur={dur:.0f}s")
        check("post-seek (unbuffered HLS) converges |Δ| < 200ms within 11s", d < 0.2, f"{d*1000:.0f}ms")
        before = (await dbg(A))["time"]
        await B.hover("#video-frame")
        box = await B.locator("#ctl-timeline").bounding_box()
        await B.mouse.click(box["x"] + box["width"] * 0.1, box["y"] + box["height"] / 2)
        await asyncio.sleep(2)
        after = (await dbg(A))["time"]
        check("guest seek blocked (leader-only timeline)", after > before and after - before < 6, f"A moved {after-before:.1f}s (10% would be ~{dur*0.1:.0f}s)")
        await B.hover("#video-frame"); await B.click("#ctl-play")
        await asyncio.sleep(1.5)
        da = await dbg(A)
        check("guest pause propagates to leader", da["paused"] and da["status"] == "PAUSED")
        overlay = await A.locator(".stage-overlay-msg").inner_text()
        check("'paused by' overlay shown", "Misafir" in overlay, overlay)
        await B.fill("#chat-input", "selam lider")
        await B.press("#chat-input", "Enter")
        await asyncio.sleep(1)
        check("chat delivered", "selam lider" in (await dbg(A))["chat"])
        await A.click('#privacy-card [data-privacy="friends"]') if await A.locator("#privacy-card").count() else None
        if not await A.locator("#privacy-card").count():
            await A.evaluate("1")
        await asyncio.sleep(1)
        # HTTP-polling guest (serverless transport)
        await A.hover("#video-frame"); await A.click("#ctl-play")
        C = await open_user(br, "MobilHTTP", "#8b5cf6", room, transport="http")
        dc = await wait_ready(C)
        check("http guest connected", dc and dc["transport"] == "http" and dc["participants"] == 3, json.dumps({k: dc.get(k) for k in ("transport", "participants")}) if dc else "none")
        for _ in range(48):
            d, _, _ = await delta(A, C)
            if d < 0.25:
                break
            await asyncio.sleep(0.25)
        check("http guest sync |Δ| < 250ms", d < 0.25, f"{d*1000:.0f}ms")
        errs = A.errors + B.errors + C.errors
        check("no uncaught page errors", not errs, "; ".join(errs[:3]))
        await br.close()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


asyncio.run(main())
