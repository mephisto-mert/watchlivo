from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

for fpath in [ROOT / "static/js/views/selection-kinds.js", ROOT / "static/js/views/selection.js"]:
    text = fpath.read_text(encoding="utf-8")
    lines = text.split("\n")
    print(f"=== {fpath.name} ===")
    for i, line in enumerate(lines):
        if any(k in line.lower() for k in ["renderdisney", "renderprime", "renderapple", "rendernetflix", "rendermax", "renderexxen", "renderblu"]):
            print(f"Line {i+1}: {line.strip()[:100]}")
