from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

for i, l in enumerate(lines):
    if l.startswith("export function renderMaxRavePortal"):
        print(f"renderMaxRavePortal starts at line {i+1}")
    elif l.startswith("export const NETFLIX_OFFICIAL_HUBS"):
        print(f"NETFLIX_OFFICIAL_HUBS starts at line {i+1}")
    elif l.startswith("export function renderNetflixRavePortal"):
        print(f"renderNetflixRavePortal starts at line {i+1}")
    elif l.startswith("export function renderCatalogKind"):
        print(f"renderCatalogKind starts at line {i+1}")
