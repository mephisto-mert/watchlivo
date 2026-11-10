import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request("https://watchlivo.online/static/js/views/selection-kinds.js?v=20261110_v181", headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
    code = resp.read().decode("utf-8")
    assert "vOWcqC4oDQws1doDWLO7d3dh5qc" in code, "The Penguin authentic poster missing in live JS"
    assert "s1wP1YeQS9fgSHiXZ3yJb2ufB2D" not in code, "DOTA poster still found in live JS"
    assert "sGPoP2RYLifBh9ZYFVn2H74r9RW" in code, "Organize Isler authentic backdrop missing in live JS"
    assert "i8ORB1biusVy703lGxUi5Rle6zA" in code, "Dexter authentic poster missing in live JS"
    assert "3Cz7ySOQJmqiuTdrc6CY0r65yDI" in code, "House M.D. authentic poster missing in live JS"
    assert "rTmal9fDbwh5F0waol2hq35U4ah" in code, "Narcos authentic poster missing in live JS"
    print("LIVE JS SCRIPT IMAGE VERIFICATION: 100% SUCCESSFUL!")
