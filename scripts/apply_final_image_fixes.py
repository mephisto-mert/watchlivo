from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

replacements = {
    # Squid Game backdrop
    "2meX1nMdScFOoV4370rqHWFDx0O.jpg": "2meX1nMdScFOoV4370rqHWKmXhY.jpg",
    # La Casa de Papel backdrop
    "gFZriCkpJYsApPwyQ9nxke46Gpu.jpg": "xGexTKCJDkl12dTW4YCBDXWb1AD.jpg",
    # Hajime no Ippo poster & backdrop
    "7V9B7H6c5mJ4Z2a5vN4K8l0sE.jpg": "gW14n6xxONXrya8CIDhRe5Ada7U.jpg",
    # Monster poster & backdrop
    "7wYh4T2a1b3c4d5e6f7g8h9i0j.jpg": "kF0DWjx3MfYRncPGSBoaL41StPe.jpg",
    # Cyberpunk backdrop
    "sLWUTu2kO80V91zZlVf8iGkM4Yk.jpg": "bknKZO7DWVYKeByuJMnGI46PFZg.jpg",
    # Ölümlü Dünya backdrop
    "jF8pE1mO3hG6a5n8b9v2c4x1z7q.jpg": "6V9AbZvuHi4vEFSnLMr1NnGCzic.jpg",
    # Mindhunter backdrop
    "fbKE87mojpIETWepSbD5Qt741d7.jpg": "lpDVJuIro21gtMj9iXMFKHuroZN.jpg",
    # Organize Isler hero
    "8YFLbXvHl686Yg5fI1PZ2W7v2.jpg": "sGPoP2RYLifBh9ZYFVn2H74r9RW.jpg",
    # The Penguin
    "s1wP1YeQS9fgSHiXZ3yJb2ufB2D.jpg": "vOWcqC4oDQws1doDWLO7d3dh5qc.jpg",
}

for rel_path in ["static/js/views/selection-kinds.js", "static/js/accounts.js"]:
    fpath = ROOT / rel_path
    text = fpath.read_text(encoding="utf-8")
    orig = text
    for old_val, new_val in replacements.items():
        if old_val in text:
            text = text.replace(old_val, new_val)
            print(f"[{fpath.name}] Replaced {old_val} -> {new_val}")
    if text != orig:
        fpath.write_text(text, encoding="utf-8")
        print(f"Updated {fpath.name}")
    else:
        print(f"No changes for {fpath.name}")
