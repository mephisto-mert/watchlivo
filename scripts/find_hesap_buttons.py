from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

for i, line in enumerate(lines):
    if "şifresiz" in line.lower() or "hesap değiştir" in line.lower() or "resmi izleme & oda portalı" in line.lower():
        print(f"Line {i+1}: {line.strip()[:120]}")
        for j in range(max(0, i-5), min(len(lines), i+15)):
            print(f"  {j+1}: {lines[j]}")
        print()
