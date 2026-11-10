import io
import os
import re
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
MIRROR = r"c:\Users\pc\Documents\projelerim\watchlivo"
NEW_VER = "20261110_v181"
PATTERN = re.compile(r"20261110_v1(?:6[5-9]|7\d|80)")

# 1. Remove Option-B root files if present
for fname in ["implement_option_b_netflix.py", "test_netflix_bridge_audit.py"]:
    fpath = os.path.join(ROOT, fname)
    if os.path.exists(fpath):
        os.remove(fpath)
        print(f"Removed {fname}")

# 2. Bump version strings across ROOT
bumped_count = 0
for dirpath, dirnames, filenames in os.walk(ROOT):
    if ".git" in dirnames:
        dirnames.remove(".git")
    if "__pycache__" in dirnames:
        dirnames.remove("__pycache__")
    for fn in filenames:
        if not fn.endswith((".html", ".js", ".css", ".py", ".json")):
            continue
        if fn == "bump_v181.py":
            continue
        p = os.path.join(dirpath, fn)
        try:
            with open(p, "r", encoding="utf-8") as f:
                txt = f.read()
        except Exception:
            continue
        new_txt = PATTERN.sub(NEW_VER, txt)
        if new_txt != txt:
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(new_txt)
            bumped_count += 1

print(f"Bumped version to {NEW_VER} in {bumped_count} files.")

# 3. Sync core files to watchlivo mirror if present
if os.path.isdir(MIRROR):
    for rel in [
        "server.py",
        "rooms.py",
        "static/index.html",
        "static/desktop-auth.html",
        "static/sw.js",
        "static/css/vortex.css",
    ]:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(MIRROR, rel)
        if os.path.exists(src) and os.path.isdir(os.path.dirname(dst)):
            shutil.copy2(src, dst)
    js_src = os.path.join(ROOT, "static", "js")
    js_dst = os.path.join(MIRROR, "static", "js")
    if os.path.isdir(js_src) and os.path.isdir(js_dst):
        for dp, _, fns in os.walk(js_src):
            for fn in fns:
                if fn.endswith(".js"):
                    s = os.path.join(dp, fn)
                    rel_p = os.path.relpath(s, js_src)
                    d = os.path.join(js_dst, rel_p)
                    os.makedirs(os.path.dirname(d), exist_ok=True)
                    shutil.copy2(s, d)
    print("Synced files to watchlivo mirror.")

# 4. Syntax check Python and JS
subprocess.run([sys.executable, "-m", "py_compile", os.path.join(ROOT, "server.py"), os.path.join(ROOT, "rooms.py")], check=True)
print("Python py_compile: OK")

js_files = []
for dp, _, fns in os.walk(os.path.join(ROOT, "static", "js")):
    for fn in fns:
        if fn.endswith(".js"):
            js_files.append(os.path.join(dp, fn))

for jf in js_files:
    subprocess.run(["node", "--check", jf], check=True)
print(f"Node --check on {len(js_files)} JS files: OK")
