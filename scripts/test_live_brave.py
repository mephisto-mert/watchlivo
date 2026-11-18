import asyncio
import sys
import io
import os
from playwright.async_api import async_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

brave_path = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
if not os.path.exists(brave_path):
    brave_path = r"C:\Users\pc\AppData\Local\BraveSoftware\Brave-Browser\Application\brave.exe"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=brave_path, headless=True)
        page = await browser.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: console_errors.append(str(exc)))

        print(f"Navigating with Brave ({brave_path}) to https://watchlivo.online/#/ ...")
        await page.goto("https://watchlivo.online/#/", wait_until="networkidle", timeout=30000)

        # Wait for provider tiles
        await page.wait_for_timeout(2000)

        # Find Netflix button
        netflix_btn = page.locator('text=Netflix').first
        print("Clicking Netflix button...")
        await netflix_btn.click()

        await page.wait_for_timeout(3000)

        # Check if rave-portal-direct-window or iframe exists
        iframe_count = await page.locator('iframe#rave-live-netflix-iframe').count()
        portal_count = await page.locator('.rave-portal-direct-window').count()
        print(f"rave-portal-direct-window count: {portal_count}")
        print(f"rave-live-netflix-iframe count: {iframe_count}")

        # Check console errors
        print(f"Total console/page errors captured: {len(console_errors)}")
        for err in console_errors:
            print(f"  ERR: {err}")

        # Take screenshot for confirmation
        await page.screenshot(path="audit_live_v172_netflix.png", full_page=True)
        print("Screenshot saved to audit_live_v172_netflix.png")

        await browser.close()

asyncio.run(main())
