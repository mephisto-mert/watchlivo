from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sk_file = ROOT / "static/js/views/selection-kinds.js"
lines = sk_file.read_text(encoding="utf-8").split("\n")

print(f"Total lines in selection-kinds.js: {len(lines)}")
# Check where renderCatalogKind starts and ends
start = 700
end = 1350
for i in range(start, min(end, len(lines))):
    l = lines[i]
    if any(k in l for k in ["authHolder", "p.id === 'max'", "p.id === 'netflix'", "renderCategoryView", "renderSections", "CATALOG_CATEGORIES", "CATALOG_PLATFORM_HEROES"]):
        print(f"Line {i+1}: {l.strip()[:100]}")
