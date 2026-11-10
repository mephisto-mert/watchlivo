from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

print("=== MAX PORTAL START ===")
for i in range(1975, 2030):
    if i < len(lines):
        print(f"{i+1}: {lines[i]}")

print("\n=== NETFLIX PORTAL START ===")
for i in range(2380, 2440):
    if i < len(lines):
        print(f"{i+1}: {lines[i]}")
