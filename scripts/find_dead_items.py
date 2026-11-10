from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

dead_hashes = [
    "2meX1nMdScFOoV4370rqHWFDx0O",
    "7V9B7H6c5mJ4Z2a5vN4K8l0sE",
    "7wYh4T2a1b3c4d5e6f7g8h9i0j",
    "fbKE87mojpIETWepSbD5Qt741d7",
    "gFZriCkpJYsApPwyQ9nxke46Gpu",
    "jF8pE1mO3hG6a5n8b9v2c4x1z7q",
    "sLWUTu2kO80V91zZlVf8iGkM4Yk",
]

for dh in dead_hashes:
    for i, line in enumerate(lines):
        if dh in line:
            print(f"Hash {dh} found at line {i+1}:")
            for j in range(max(0, i-2), min(len(lines), i+6)):
                print(f"  {lines[j].strip()}")
            print()
