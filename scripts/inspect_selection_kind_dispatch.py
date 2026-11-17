from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sel_kinds = ROOT / "static/js/views/selection-kinds.js"
lines = sel_kinds.read_text(encoding="utf-8").split("\n")

for i in range(680, 740):
    if i < len(lines):
        print(f"{i+1}: {lines[i]}")
