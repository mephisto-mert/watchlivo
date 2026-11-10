import subprocess

cmd = ["git", "show", "6f9f0b1:static/js/views/selection-kinds.js"]
res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
lines = res.stdout.splitlines()

for i, l in enumerate(lines):
    if l.startswith("export function "):
        print(f"Line {i+1}: {l}")
