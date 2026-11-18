import os
import glob

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
pattern1 = os.path.join(base_dir, "static", "**", "*.js")
pattern2 = os.path.join(base_dir, "static", "**", "*.html")

all_files = glob.glob(pattern1, recursive=True) + glob.glob(pattern2, recursive=True)
all_files.append(os.path.join(base_dir, "static", "sw.js"))
all_files.append(os.path.join(base_dir, "server.py"))
all_files.append(os.path.join(base_dir, "deploy", "domain_failover_config.json"))
all_files.extend(glob.glob(os.path.join(base_dir, "tests", "**", "*.py"), recursive=True))

updated = 0
for p in set(all_files):
    if not os.path.isfile(p):
        continue
    try:
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()
        new_content = content
        for old_ver in ("20261111_v205", "20261111_v197", "20261111_v196"):
            if old_ver in new_content:
                new_content = new_content.replace(old_ver, "20261112_v208")
        if new_content != content:
            with open(p, "w", encoding="utf-8") as f:
                f.write(new_content)
            updated += 1
            print(f"[OK] Bumped to v206: {os.path.relpath(p, base_dir)}")
    except Exception as e:
        print(f"[ERR] {p}: {e}")

print(f"Total files updated: {updated}")
