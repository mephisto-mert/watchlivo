from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

for fpath in [ROOT / "static/js/views/selection-kinds.js", ROOT / "static/js/accounts.js"]:
    text = fpath.read_text(encoding="utf-8")
    lines = text.split("\n")
    print(f"=== {fpath.name} ===")
    for i, line in enumerate(lines):
        if any(k in line.lower() for k in ["penguin", "karun", "amerika yapımı", "dota"]):
            start = max(0, i - 5)
            end = min(len(lines), i + 15)
            print(f"--- Line {i+1} ---")
            for j in range(start, end):
                print(f"{j+1}: {lines[j]}")
            print()
