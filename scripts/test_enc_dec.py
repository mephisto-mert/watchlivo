import urllib.request
import urllib.parse
import json

stage1_u = "https://vidfast.vc/02b650dd8a0bf728bcbfea0aab197d9325a7cc5d/a/e4f5a08ebf9d4e599053cf21aa515ad40a9ab18d476699449b37c81712377936/APA915Y0kb_4Ob2_n53xSIYK5JMhBUcz4D2X2gKEOyWiIfDG86ZKJ-19kBv1TLwEA2en2gcPv8T187a38WpllnC_HbNtq0zHvsKAXAfTJGK4a_bmveG7187iGsbjX2BFG3iC-fAllDWjS1vnIaxENzFXZY7xuAl0i8JQIqs8BoPr_JPhnXsgEp9/AXxiXOOewoE/VjEzQgENAQAAKxAQIAAAAABWAAAAVgAYOHJHZWZkUmIyRy1CVE1NMGxCQUdkQmg0TDNLemJJclhfYnRaT1hzTnhqY41Gw3Ld3QOQax5LJb-yeERcRrsBjydIgDVFKBEm-lPEpudnRc7qzrFWp-LcV-7u9fua-U5J3vSW2RL1-CIsg2fV2Df__i40lBT4feTodVN71zSVUY1c3B4LMlIWv53iGTcVJuQXOPskVd4q8sZ_W_-lAr1Og48ehw6WPNI5BfkQ6hc4xPNbkWiBEIC_6Hn1_T2cQMx-8A"
UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

vf_hdrs = {"User-Agent": UA137, "Referer": "https://vidfast.vc/", "X-Requested-With": "XMLHttpRequest"}
try:
    req = urllib.request.Request(stage1_u, data=b"", headers=vf_hdrs)
    with urllib.request.urlopen(req, timeout=4.0) as r:
        t1 = r.read().decode("utf-8", errors="ignore")
    print("Stage 1 fetch len:", len(t1), "content start:", t1[:200])
except Exception as e:
    print("Stage 1 fetch error:", e)
