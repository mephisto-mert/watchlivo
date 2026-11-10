import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://image.tmdb.org/t/p/w780/4Mt7WHox67uJ1yErwTBFcV8KWgG.jpg"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, context=ctx) as r:
    data = r.read()
    with open("c:/Users/pc/Documents/projelerim/rave_web_platform/scripts/solo_backdrop.jpg", "wb") as f:
        f.write(data)
print("Saved solo_backdrop.jpg, size:", len(data))
