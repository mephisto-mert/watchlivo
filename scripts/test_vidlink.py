import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server

enc_id = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEj4SZE3rUtXl-VOofMQ_caKC89-dFYZ2cQgemao"
ep = f"https://vidlink.pro/api/b/movie/{enc_id}?multiLang=0"
st_doc = server._raw_get_json(ep, headers={"Referer": "https://vidlink.pro/", "Origin": "https://vidlink.pro"}, timeout=3.4)
st = (st_doc or {}).get("stream") or {}
print("st keys:", st.keys())
print("quals:", st.get("qualities"))
