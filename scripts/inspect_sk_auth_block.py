from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

print("--- Lines 705-750 ---")
for i in range(705, 750):
    print(f"{i+1}: {lines[i]}")

print("\n--- Lines 945-965 ---")
for i in range(945, 965):
    print(f"{i+1}: {lines[i]}")
