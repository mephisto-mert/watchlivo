import urllib.request

u = "https://s23.cdnimage7200.shop/m2/HTkuozI0YxE1ozHhZwNlZF5PoUIlLKxhZGN4ZUNhESIOGNd0zxL2EhnJ1uM2H3ZwNjYaAbo3Ns0xi23vr1"
UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

req = urllib.request.Request(u, headers={"User-Agent": UA137, "Referer": "https://rapidvid.org/", "Origin": "https://rapidvid.org"})
try:
    with urllib.request.urlopen(req, timeout=3.0) as r:
        txt = r.read(2048).decode("utf-8", errors="ignore")
    print("Status:", r.status, "Is HLS:", "#EXTM3U" in txt)
except Exception as e:
    print("Error:", e)
