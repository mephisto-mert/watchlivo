import io
import json
import shutil
import sys
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parent.parent
PUBLIC_DIR = REPO / "workers" / "ha-gateway" / "public"
EDGE_DIR = PUBLIC_DIR / "_edge"


def fetch_local_json(path: str, fallback):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:8080{path}", timeout=6) as r:
            if r.status == 200:
                return json.loads(r.read().decode("utf-8"))
    except Exception:
        pass
    return fallback


def main() -> None:
    prev_boot = {}
    prev_boot_path = EDGE_DIR / "bootstrap.json"
    if prev_boot_path.exists():
        try:
            prev_boot = json.loads(prev_boot_path.read_text(encoding="utf-8"))
        except Exception:
            prev_boot = {}

    if PUBLIC_DIR.exists():
        shutil.rmtree(PUBLIC_DIR)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    EDGE_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Copy static assets under /static/* (excluding >24 MiB desktop installers) and root entrypoints
    static_src = REPO / "static"

    def _ignore_oversized(dirpath: str, names: list[str]) -> set[str]:
        skipped = set()
        dp = Path(dirpath)
        for nm in names:
            if nm.startswith("js_backup"):
                skipped.add(nm)
                continue
            fp = dp / nm
            try:
                if fp.is_file() and fp.stat().st_size > 24 * 1024 * 1024:
                    skipped.add(nm)
            except OSError:
                pass
        return skipped

    shutil.copytree(static_src, PUBLIC_DIR / "static", ignore=_ignore_oversized)
    shutil.copy2(static_src / "index.html", PUBLIC_DIR / "index.html")
    if (static_src / "manifest.json").exists():
        shutil.copy2(static_src / "manifest.json", PUBLIC_DIR / "manifest.json")
        shutil.copy2(static_src / "manifest.json", PUBLIC_DIR / "manifest.webmanifest")
    if (static_src / "watchlivo-icon-192.png").exists():
        shutil.copy2(static_src / "watchlivo-icon-192.png", PUBLIC_DIR / "favicon.ico")
        shutil.copy2(static_src / "watchlivo-icon-192.png", PUBLIC_DIR / "apple-touch-icon.png")
        shutil.copy2(static_src / "watchlivo-icon-192.png", PUBLIC_DIR / "apple-touch-icon-precomposed.png")
    for ver_file in ("app_version.json", "ios_version.json"):
        if (REPO / ver_file).exists():
            shutil.copy2(REPO / ver_file, PUBLIC_DIR / ver_file)

    # 2. Export curated rooms (only rooms whose media is directly playable; never proxied/re-streamed URLs)
    rooms_payload = fetch_local_json("/api/rooms", {"rooms": prev_boot.get("curatedRooms") or []})
    curated_rooms = []
    for r in rooms_payload.get("rooms", []):
        if not isinstance(r, dict) or not r.get("curated"):
            continue
        media = r.get("media") or {}
        media_url = str(media.get("url") or "")
        if "/api/rave/stream" in media_url:
            continue
        curated_rooms.append(r)

    bootstrap = {
        "version": str(_read_app_version() or prev_boot.get("version") or ""),
        "curatedRooms": curated_rooms,
    }
    (EDGE_DIR / "bootstrap.json").write_text(
        json.dumps(bootstrap, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"[EdgeBundle] Built successfully: curated_rooms={len(curated_rooms)}")


def _read_app_version() -> str:
    try:
        data = json.loads((REPO / "app_version.json").read_text(encoding="utf-8"))
        return str(data.get("version") or data.get("versionName") or "")
    except Exception:
        return ""


if __name__ == "__main__":
    main()
