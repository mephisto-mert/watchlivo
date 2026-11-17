import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

# Let's test _job_hexa logic for Dune 2
tid = "693134"
mtype = "movie"
s_tmdb = 1
e_tmdb = 1

UA137 = server.UA137
import os
import json
import urllib.request
import urllib.error

host_dom = "theemoviedb.hexa.su"
try:
    hx_cap_hdrs = {"User-Agent": UA137, "Origin": "https://hexa.su", "Referer": "https://hexa.su/", "Content-Type": "application/json"}
    ch = server._raw_get_json("https://cap.hexa.su/15d2cf0395/challenge", headers=hx_cap_hdrs, data=b"{}", timeout=3.0)
    print("Hexa challenge:", ch)
    if isinstance(ch, dict) and ch.get("token"):
        sol = (server._raw_get_json("https://enc-dec.app/api/enc-hexa", headers={"Content-Type": "application/json"}, data=json.dumps({"challenge_data": ch}).encode("utf-8"), timeout=4.0) or {}).get("result")
        print("Hexa solution:", sol)
        if isinstance(sol, dict) and sol.get("token"):
            red = server._raw_get_json("https://cap.hexa.su/15d2cf0395/redeem", headers=hx_cap_hdrs, data=json.dumps(sol).encode("utf-8"), timeout=3.4) or {}
            tok = str(red.get("token") or "").strip()
            print("Hexa redeem token:", tok)
            key = os.urandom(32).hex()
            hdrs = {
                "User-Agent": UA137, "Referer": "https://hexa.su/", "Origin": "https://hexa.su",
                "Accept": "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": tok,
            }
            ep = f"https://{host_dom}/api/tmdb/movie/{tid}/images"
            req = urllib.request.Request(ep, headers=hdrs)
            with urllib.request.urlopen(req, timeout=4.2) as r:
                enc_txt = r.read(server.MAX_PAGE_BYTES).decode("utf-8", errors="ignore")
            print("Hexa enc_txt len:", len(enc_txt))
            dec = server._raw_get_json("https://enc-dec.app/api/dec-hexa", headers={"Content-Type": "application/json"}, data=json.dumps({"text": enc_txt, "key": key}).encode("utf-8"), timeout=4.2)
            srcs = ((dec.get("result") or {}).get("sources") or []) if isinstance(dec.get("result"), dict) else []
            print("Hexa sources:", srcs)
except Exception as e:
    print("Hexa error:", e)
