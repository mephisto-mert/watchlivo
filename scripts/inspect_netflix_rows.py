from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

for i in range(2950, min(3100, len(lines))):
    print(f"{i+1}: {lines[i]}")
