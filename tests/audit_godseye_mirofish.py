"""God's Eye + MiroFish 5-Persona Full Rave-Parity Audit Suite."""
import asyncio, json, pathlib, subprocess, sys
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = pathlib.Path(__file__).resolve().parent.parent
PY = sys.executable
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"


def run_suite(script):
    p = subprocess.run([PY, str(ROOT / "tests" / script), BASE], capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(f"=== {script} (exit={p.returncode}) ===")
    print(p.stdout.strip())
    if p.returncode != 0 and p.stderr:
        print(p.stderr.strip())
    return p.returncode == 0


async def godseye_dom_audit():
    anomalies = []
    async with async_playwright() as p:
        br = await p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required", "--mute-audio"])
        ctx = await br.new_context(viewport={"width": 1440, "height": 860}, locale="tr-TR")
        await ctx.add_init_script("localStorage.setItem('vortex_profile_v2', JSON.stringify({id:'uid-audit',name:'Denetmen',color:'#00f5d4'}))")
        page = await ctx.new_page()
        page.on("pageerror", lambda e: anomalies.append(f"pageerror: {e}"))
        await page.goto(f"{BASE}/#/", wait_until="networkidle")
        dom_home = await page.evaluate("""() => {
            const badText = document.body.innerText.match(/\\b(undefined|NaN)\\b/g) || [];
            const imgs = [...document.querySelectorAll('.provider-tile img')];
            const brokenImgs = imgs.filter(i => !i.complete || i.naturalWidth === 0).length;
            const tiles = document.querySelectorAll('.provider-tile').length;
            const tileBg = getComputedStyle(document.querySelector('.provider-tile')).backgroundColor;
            return { badText, brokenImgs, tiles, tileBg };
        }""")
        if dom_home["badText"]:
            anomalies.append(f"home bad text: {dom_home['badText']}")
        if dom_home["brokenImgs"] > 0:
            anomalies.append(f"home broken provider logos: {dom_home['brokenImgs']}")
        if dom_home["tiles"] < 12:
            anomalies.append(f"home provider tiles < 12: {dom_home['tiles']}")
        # Mobile responsiveness check (390x844)
        await page.set_viewport_size({"width": 390, "height": 844})
        overflow = await page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
        if overflow:
            anomalies.append("mobile horizontal overflow on Home")
        await br.close()
    return anomalies, dom_home


def main():
    s1 = run_suite("test_api.py")
    s2 = run_suite("e2e_sync.py")
    s3 = run_suite("e2e_room_selection.py")
    anomalies, dom_home = asyncio.run(godseye_dom_audit())
    personas = {
        "Rave Power User (Home + MeshLayout + In-Room Selection)": 100 if (s3 and not anomalies) else 75,
        "Distributed Sync Engineer (jumpSync + speedSync + HTTP fallback)": 100 if s2 else 70,
        "UI/UX & Brand Parity Auditor (Rave CSS Tokens + MeshThumbFC + Logos)": 100 if not anomalies else 80,
        "Security & Privacy Auditor (SSRF + XSS + PlayMode/Privacy Gates)": 100 if (s1 and s2) else 70,
        "Mobile & Cross-Browser QA (390x844 + Multi-Context Chromium)": 100 if (s2 and s3 and not anomalies) else 75,
    }
    avg = sum(personas.values()) / len(personas)
    report = {"suites": {"test_api": s1, "e2e_sync": s2, "e2e_room_selection": s3}, "godseye_anomalies": anomalies, "dom_home": dom_home, "mirofish_personas": personas, "mirofish_score": avg}
    print("\n=== GOD'S EYE + MIROFISH REPORT ===")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    sys.exit(0 if (s1 and s2 and s3 and not anomalies and avg == 100) else 1)


if __name__ == "__main__":
    main()
