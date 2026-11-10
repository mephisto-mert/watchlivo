import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

api_key = "4f042878f22ef63cb94f25e60cb4ec6e"

def get_tv(tid):
    url = f"https://api.themoviedb.org/3/tv/{tid}?api_key={api_key}&language=en-US"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read().decode())

solo = get_tv(127532)
print("Solo Leveling:")
print("  Name:", solo.get("name"))
print("  Poster:", solo.get("poster_path"))
print("  Backdrop:", solo.get("backdrop_path"))

one_piece = get_tv(37854)
print("One Piece:")
print("  Name:", one_piece.get("name"))
print("  Poster:", one_piece.get("poster_path"))
print("  Backdrop:", one_piece.get("backdrop_path"))
