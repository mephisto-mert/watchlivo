import urllib.request
import urllib.parse
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))

test_cases = [
    {"tid": "100088", "t": "The Last of Us", "y": "2023", "mt": "tv"},
    {"tid": "", "t": "Don't Look Up", "y": "2021", "mt": "movie"},
    {"tid": "", "t": "Stranger Things", "y": "", "mt": "tv"},
    {"tid": "127532", "t": "Solo Leveling", "y": "2024", "mt": "tv"},
    {"tid": "ep-127532-s2e12", "t": "Solo Leveling", "y": "", "mt": "tv"},
]

for tc in test_cases:
    url = "https://watchlivo.online/api/rave/poster?" + urllib.parse.urlencode(tc)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        resp = opener.open(req, timeout=8)
        print(f"QUERY: {tc['t']} ({tc['tid']}) -> Status {resp.status}, Content-Type: {resp.headers.get('Content-Type')}")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
        print(f"QUERY: {tc['t']} ({tc['tid']}) -> Redirect {e.code} to: {loc}")
    except Exception as e:
        print(f"QUERY: {tc['t']} ({tc['tid']}) -> Error: {e}")
