import subprocess

cmd = ["git", "show", "6f9f0b1:static/js/views/selection-kinds.js"]
res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
lines = res.stdout.splitlines()

for i in range(860, 960):
    if i < len(lines):
        print(f"{i+1}: {lines[i]}")
