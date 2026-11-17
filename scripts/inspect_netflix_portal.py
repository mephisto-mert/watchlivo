from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

start = 2380
end = 2800
for i in range(start, min(end, len(lines))):
    print(f"{i+1}: {lines[i]}")
