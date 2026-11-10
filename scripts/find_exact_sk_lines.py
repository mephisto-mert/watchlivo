from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
text = sk_file.read_text(encoding="utf-8")

lines = text.split("\n")
for i, line in enumerate(lines):
    if "The Penguin" in line or "118956" in line:
        for j in range(max(0, i-2), min(len(lines), i+8)):
            print(f"{j+1}: {lines[j]}")
        print()
    if "Organize İşler" in line or "Karun Hazinesi" in line:
        for j in range(max(0, i-2), min(len(lines), i+15)):
            print(f"{j+1}: {lines[j]}")
        print()
    if "Amerika Yapımı" in line:
        for j in range(max(0, i-2), min(len(lines), i+20)):
            print(f"{j+1}: {lines[j]}")
        print()
