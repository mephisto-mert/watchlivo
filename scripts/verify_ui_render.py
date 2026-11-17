# -*- coding: utf-8 -*-
import sys
import io
import time
import subprocess
import os
from playwright.sync_api import sync_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

def run_test():
    # Start local uvicorn server in background
    print("[*] Starting local test server...")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8765"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=r"c:\Users\pc\Documents\projelerim\rave_web_platform"
    )
    time.sleep(3)
    
    errors = []
    messages = []
    brave_path = os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe")
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=brave_path, headless=True)
            page = browser.new_page()
            
            page.on("console", lambda msg: messages.append(f"[{msg.type}] {msg.text}"))
            page.on("pageerror", lambda err: errors.append(str(err)))
            
            print("[*] Navigating to http://127.0.0.1:8765/#/ ...")
            page.goto("http://127.0.0.1:8765/#/")
            page.wait_for_timeout(3500)
            
            print("[*] Console messages:")
            for m in messages:
                print(f"    {m}")
                
            print(f"[*] Page Errors: {len(errors)}")
            for e in errors:
                print(f"    [PAGE ERROR] {e}")
                
            # Check if root container or nav is visible
            is_nav_visible = page.is_visible(".home") or page.is_visible("#app") or page.is_visible(".panel-body")
            print(f"[*] UI Container Visible: {is_nav_visible}")
            
            page.screenshot(path="ui_render_brave.png")
            print("[+] Screenshot saved to ui_render_brave.png")
            browser.close()
            
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except Exception:
            proc.kill()
            
    assert len(errors) == 0, f"Found {len(errors)} page errors!"
    print("[PASS] Page loaded in Brave with 0 errors!")

if __name__ == "__main__":
    run_test()
