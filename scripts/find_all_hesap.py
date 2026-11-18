import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

for root, dirs, files in os.walk(ROOT / "static/js"):
    for f in files:
        if f.endswith(".js"):
            p = os.path.join(root, f)
            text = Path(p).read_text(encoding="utf-8", errors="ignore")
            for word in ["şifresiz", "hesap değiştir", "hesap"]:
                if word in text.lower():
                    for i, l in enumerate(text.split("\n")):
                        if word in l.lower() and ("netflix" in l.lower() or "button" in l.lower() or "acct" in l.lower() or "badge" in l.lower()):
                            print(f"{f}:{i+1} -> {l.strip()[:100]}")
