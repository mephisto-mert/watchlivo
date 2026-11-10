import re

with open("server.py", "r", encoding="utf-8", errors="replace") as f:
    text = f.read()

# Routes can be @app.route, @app.get, @app.post, @router.get, etc.
routes = re.findall(r'@(?:app|router|api)\.(?:route|get|post|put|delete)\(\s*["\']([^"\']+)["\']', text)
print(f"Total routes found: {len(routes)}")
for r in routes:
    print(r)
