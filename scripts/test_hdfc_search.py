import sys
base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)
import server
import urllib.parse
import re

for q in ["Dune", "Dune 2", "Dune Çöl Gezegeni"]:
    try:
        url = f"https://www.hdfilmcehennemi.nl/search?q={urllib.parse.quote(q)}"
        res = server._raw_get_json(url, headers={"User-Agent": server.UA137, "Referer": "https://www.hdfilmcehennemi.nl/", "X-Requested-With": "fetch"}, timeout=4.0)
        print("SEARCH", q, "result count:", len(res.get("results", [])))
        for r_html in res.get("results", []):
            m_href = re.search(r'href=["\']([^"\']+)["\']', str(r_html))
            m_alt = re.search(r'alt=["\']([^"\']+)["\']', str(r_html))
            print("  Href:", m_href.group(1) if m_href else "?", "Alt:", m_alt.group(1) if m_alt else "?")
    except Exception as e:
        print("Error on", q, ":", e)
