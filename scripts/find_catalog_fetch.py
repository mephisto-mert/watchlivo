from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

for i, line in enumerate(lines):
    if "/api/rave/catalog" in line or "fetch(" in line:
        print(f"Line {i+1}: {line.strip()[:100]}")
