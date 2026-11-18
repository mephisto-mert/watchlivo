from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

for i, l in enumerate(lines):
    if "export function renderMaxRavePortal" in l:
        print(f"renderMaxRavePortal starts at {i+1}")
    if "export const NETFLIX_OFFICIAL_HUBS" in l:
        print(f"NETFLIX_OFFICIAL_HUBS starts at {i+1}")
    if "export function renderNetflixRavePortal" in l:
        print(f"renderNetflixRavePortal starts at {i+1}")
    if i > 3200 and l.startswith("}"):
        print(f"File end or closing brace at {i+1}: {l}")
