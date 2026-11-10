import re

with open(r"c:\Users\pc\Documents\projelerim\rave_web_platform\server.py", "r", encoding="utf-8", errors="ignore") as f:
    content = f.read()

endpoints = re.findall(r'Route\(["\']([^"\']+)["\'],\s*([^,\)]+)', content)
for path, handler in endpoints:
    if any(k in path.lower() for k in ["resolve", "stream", "room", "catalog", "manifest", "play"]):
        print(f"{path:40} -> {handler}")
