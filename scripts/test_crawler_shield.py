import re

_CRAWLER_BOT_REGEX = re.compile(
    r"(?i)(googlebot|bingbot|yandex|baiduspider|slurp|duckduckbot|ahrefsbot|semrushbot|"
    r"dotbot|mj12bot|bytespider|petalbot|markmonitor|corsearch|opsec|digimarc|"
    r"muso|leakix|censys|shodan|netcraft|screaming\s*frog|turnitin|scrapy)"
)

test_uas = [
    # Should match (Crawlers)
    ("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", True),
    ("Googlebot/2.1 (+http://www.google.com/bot.html)", True),
    ("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", True),
    ("Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", True),
    ("Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", True),
    ("Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", True),
    ("Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)", True),
    ("MarkMonitor AntiPiracy Harvester 2.4", True),
    ("OpSec Online Antipiracy Crawler", True),
    ("MUSO Copyright Scanner v1.0", True),
    ("Scrapy/2.11.0 (+https://scrapy.org)", True),

    # Should NOT match (Legitimate users & clients)
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", False),
    ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", False),
    ("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36", False),
    ("Watchlivo-Android/2.0.2", False),
    ("testclient", False),
]

failed = 0
for ua, expected in test_uas:
    matched = bool(_CRAWLER_BOT_REGEX.search(ua))
    if matched != expected:
        print(f"FAILED: '{ua}' -> got {matched}, expected {expected}")
        failed += 1

if failed == 0:
    print("ALL 16 User-Agent tests passed successfully!")
else:
    print(f"{failed} tests failed!")
