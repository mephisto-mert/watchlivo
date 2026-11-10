import urllib.request

UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

for num in range(1600, 1630):
    dom = f"dizipal{num}.com"
    try:
        req = urllib.request.Request(f"https://{dom}/", headers={"User-Agent": UA137})
        with urllib.request.urlopen(req, timeout=2.0) as r:
            print("WORKING DIZIPAL DOMAIN:", dom, "Status:", r.status)
            break
    except Exception:
        pass
