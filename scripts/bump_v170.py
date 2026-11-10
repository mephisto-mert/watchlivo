import os

target_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
old_v = "20261110_v170"
new_v = "20261110_v170"

count = 0
for root, dirs, files in os.walk(target_dir):
    if ".git" in root or "__pycache__" in root or "node_modules" in root:
        continue
    for f in files:
        if f.endswith((".html", ".js", ".py", ".css")):
            p = os.path.join(root, f)
            with open(p, "r", encoding="utf-8", errors="ignore") as fp:
                content = fp.read()
            if old_v in content:
                new_content = content.replace(old_v, new_v)
                with open(p, "w", encoding="utf-8") as fp:
                    fp.write(new_content)
                print(f"Updated: {p}")
                count += 1

print(f"Successfully bumped {count} files to {new_v}")
