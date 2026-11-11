import os
import glob

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
pattern1 = os.path.join(base_dir, "static", "**", "*.js")
pattern2 = os.path.join(base_dir, "static", "**", "*.html")

all_files = glob.glob(pattern1, recursive=True) + glob.glob(pattern2, recursive=True)
updated = 0

for p in all_files:
    try:
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()
        if "20261111_v197" in content:
            new_content = content.replace("20261111_v197", "20261111_v205")
            with open(p, "w", encoding="utf-8") as f:
                f.write(new_content)
            updated += 1
            print(f"[OK] Bumped: {os.path.basename(p)}")
    except Exception as e:
        print(f"[ERR] {p}: {e}")

print(f"Total files updated: {updated}")
