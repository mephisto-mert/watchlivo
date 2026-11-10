import os
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

target_dirs = [
    r"c:\Users\pc\Documents\projelerim\rave_web_platform",
    r"c:\Users\pc\Documents\projelerim\watchlivo"
]
old_v = "20261110_v178"
new_v = "20261110_v178"

total_count = 0
for target_dir in target_dirs:
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
                    total_count += 1

print(f"Successfully bumped {total_count} files from {old_v} to {new_v}")
