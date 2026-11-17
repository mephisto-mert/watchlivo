import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

urls = [
    ("Dexter", "https://image.tmdb.org/t/p/w500/58H6CtF0npS1nT502r9TqUe9z1B.jpg"),
    ("House M.D.", "https://image.tmdb.org/t/p/w500/3r4LYFuXrg3G8f0vP8YvXm9f8.jpg"),
    ("Breaking Bad", "https://image.tmdb.org/t/p/w500/ggFHVNu6YYI5L9pCfOacjizRGt.jpg"),
    ("Better Call Saul", "https://image.tmdb.org/t/p/w500/fC2HDm5t0kHl7mTm7jxMR31b7by.jpg"),
    ("Narcos", "https://image.tmdb.org/t/p/w500/rTmal9fVEwh5x9hJ2Up78FS9v49.jpg"),
    ("Mindhunter", "https://image.tmdb.org/t/p/w500/fbKE87mojpIETWepYpq5Sh6kjTg.jpg"),
    ("Organize Isler Backdrop", "https://image.tmdb.org/t/p/w1280/8YFLbXvHl686Yg5fI1PZ2W7v2.jpg"),
    ("Organize Isler Poster", "https://image.tmdb.org/t/p/w500/8YFLbXvHl686Yg5fI1PZ2W7v2.jpg"),
]

for name, u in urls:
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
            print(f"{name}: HTTP {resp.status} (len={len(resp.read())})")
    except Exception as e:
        print(f"{name}: ERROR {e} -> {u}")
