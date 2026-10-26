"""UI smoke: load home, set profile, capture console errors + screenshots."""
import asyncio, sys, pathlib
from playwright.async_api import async_playwright

OUT = pathlib.Path(r"C:\Users\pc\.gemini\antigravity\brain\0bcd2c58-ffcb-4ebe-873b-242386b0f07a\scratch\shots")
OUT.mkdir(parents=True, exist_ok=True)
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 860}, locale="tr-TR")
        page = await ctx.new_page()
        errs = []
        page.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        await page.goto(BASE + "/", wait_until="domcontentloaded")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(OUT / "01_profile.png"))
        await page.fill(".popup input", "Tris")
        await page.click(".popup .btn.primary")
        await page.wait_for_timeout(2500)
        await page.screenshot(path=str(OUT / "02_home.png"))
        print("tiles:", await page.locator(".provider-tile").count())
        await page.click('.provider-tile[data-provider="youtube"]')
        await page.wait_for_timeout(4000)
        await page.screenshot(path=str(OUT / "03_home_youtube.png"))
        print("yt cards:", await page.locator(".vcard").count())
        await page.locator(".vcard").first.click()
        await page.wait_for_timeout(6000)
        print("url:", page.url)
        await page.screenshot(path=str(OUT / "04_mesh.png"))
        print("errors:", *errs[:20], sep="\n  ")
        await b.close()

asyncio.run(main())
