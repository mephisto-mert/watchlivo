import urllib.request

v = "689fd812e487e94784264c1e1dac6ab0"
UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

for n in range(75, 95):
    for sub in ["four", "five", "one", "two", "three", "six"]:
        dom = f"{sub}.dplayer{n}.site"
        u = f"https://{dom}/iframe.php?v={v}"
        try:
            req = urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://dizipal.com/"})
            with urllib.request.urlopen(req, timeout=1.5) as r:
                print("FOUND DPLAYER WORKING DOMAIN!", dom, "status:", r.status)
                break
        except Exception:
            pass
