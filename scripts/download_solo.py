import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://image.tmdb.org/t/p/w500/geCRueV3ElhRTr0xtJuEWJt6dJ1.jpg"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx) as r:
    data = r.read()
    with open("c:/Users/pc/Documents/projelerim/rave_web_platform/scripts/solo_test.jpg", "wb") as f:
        f.write(data)
print("Saved solo_test.jpg, size:", len(data))

# Also let's inspect the screenshot!
# In the screenshot media_1794296781479_1ba3e32e.png:
# Look at "Son Eklenen Yeni Bölümler"
# Card 1: Jujutsu Kaisen (Gojo)
# Card 2: Solo Leveling - has Luffy, Zoro! Wait, why does Solo Leveling have Luffy, Zoro?
# Card 3: One Piece - has Luffy, Zoro!
# Wait, look at Card 2 and Card 3 in the screenshot!
# Card 2 has Luffy with his straw hat and Zoro!
# Card 3 ALSO has Luffy with his straw hat and Zoro!
