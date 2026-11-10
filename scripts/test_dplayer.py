import sys
import os
import urllib.request
import re

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

target = "https://four.dplayer82.site/iframe.php?v=689fd812e487e94784264c1e1dac6ab0"
print("Testing dplayer iframe:", target)
try:
    req = urllib.request.Request(target, headers={"User-Agent": server.UA137, "Referer": "https://dizipal944.com/"})
    with server._public_open(req, timeout=5.0) as r:
        html = r.read().decode("utf-8", errors="ignore")
    print("HTML length:", len(html))
    m = re.findall(r"https?://[^\s'\"<>]+\.m3u8[^\s'\"<>]*", html)
    print("M3U8 matches in iframe:", m)
except Exception as e:
    print("Error:", e)
