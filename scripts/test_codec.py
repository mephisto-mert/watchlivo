import urllib.request

u = "https://bcdn.hakunaymatata.com/resource/06da6dbc1480ed6760e27b84f6fd989b.mp4?sign=c18b6a3ad1f009aa4ba13b27034e8023&t=1794241523"
UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

req = urllib.request.Request(u, headers={"User-Agent": UA137, "Range": "bytes=0-8192"})
try:
    with urllib.request.urlopen(req, timeout=4.0) as r:
        header = r.read()
    print("Downloaded bytes:", len(header))
    print("Contains avc1 (H.264):", b"avc1" in header)
    print("Contains hvc1 (H.265):", b"hvc1" in header or b"hev1" in header)
    print("Contains isom / mp42:", b"isom" in header or b"mp42" in header)
    print("First 64 bytes:", header[:64])
except Exception as e:
    print("Error:", e)
