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
SHARDS_DIR = EDGE_DIR / "streams"
NUM_BUCKETS = 64


def fnv1a_bucket(key: str, buckets: int = NUM_BUCKETS) -> int:
    h = 0x811C9DC5
    for b in key.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h % buckets


def fetch_local_json(path: str, fallback):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:8080{path}", timeout=6) as r:
            if r.status == 200:
                return json.loads(r.read().decode("utf-8"))
    except Exception:
        pass
    return fallback


def main() -> None:
    if PUBLIC_DIR.exists():
        shutil.rmtree(PUBLIC_DIR)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    EDGE_DIR.mkdir(parents=True, exist_ok=True)
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Copy static assets under /static/* (excluding >24 MiB desktop installers) and root entrypoints
    static_src = REPO / "static"

    def _ignore_oversized(dirpath: str, names: list[str]) -> set[str]:
        skipped = set()
        dp = Path(dirpath)
        for nm in names:
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

    # 2. Load vault catalog + streams
    vault = json.loads((REPO / "main_sites_vault.json").read_text(encoding="utf-8"))
    raw_cat = vault.get("catalog", {})
    raw_streams = vault.get("streams", {})

    all_items = []
    seen_ids = set()
    id_to_item = {}
    tmdb_to_items = {}
    for src_key in ("fhd", "hfnl", "dbx", "ac"):
        for item in raw_cat.get(src_key, []):
            if not isinstance(item, dict):
                continue
            iid = str(item.get("id") or "").strip()
            if not iid or iid in seen_ids:
                continue
            seen_ids.add(iid)
            all_items.append(item)
            id_to_item[iid] = item
            tid = str(item.get("tmdbId") or "").strip()
            if tid:
                tmdb_to_items.setdefault(tid, []).append(item)

    # 3. Build 64 deterministic stream shards indexed by id:<id>, tmdb:<tmdbId>, url:<officialUrl>, and raw keys
    buckets: list[dict] = [{} for _ in range(NUM_BUCKETS)]

    def put_key(k: str, val: dict) -> None:
        if not k or not isinstance(val, dict):
            return
        b = fnv1a_bucket(k)
        if k not in buckets[b]:
            buckets[b][k] = val

    for skey, sval in raw_streams.items():
        if isinstance(sval, dict) and sval.get("streams"):
            put_key(skey, sval)

    for item in all_items:
        iid = str(item.get("id") or "").strip()
        tid = str(item.get("tmdbId") or "").strip()
        ourl = str(item.get("officialUrl") or "").strip()
        entry = (
            raw_streams.get(f"id:{iid}")
            or (raw_streams.get(f"url:{ourl}") if ourl else None)
            or (raw_streams.get(f"tmdb:{tid}") if tid else None)
        )
        if isinstance(entry, dict) and entry.get("streams"):
            enriched = {
                "streams": entry.get("streams", []),
                "subs": entry.get("subs", []),
                "title": item.get("title", ""),
                "originalTitle": item.get("originalTitle", ""),
                "year": item.get("year", ""),
                "mediaType": item.get("mediaType", "movie"),
                "tmdbId": tid,
                "id": iid,
            }
            if iid:
                put_key(f"id:{iid}", enriched)
            if tid:
                put_key(f"tmdb:{tid}", enriched)
            if ourl:
                put_key(f"url:{ourl}", enriched)

    for idx, data in enumerate(buckets):
        shard_path = SHARDS_DIR / f"b{idx:02x}.json"
        shard_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 4. Export curated Live TV rooms, new releases, and latest episodes
    rooms_payload = fetch_local_json("/api/rooms", {"rooms": []})
    curated_rooms = [r for r in rooms_payload.get("rooms", []) if isinstance(r, dict) and r.get("curated")]
    new_rel = fetch_local_json("/api/rave/new-releases", {"ok": True, "items": all_items[:24]})
    latest_eps = fetch_local_json("/api/rave/latest-episodes", {"ok": True, "items": []})

    bootstrap = {
        "version": "20261112_v208",
        "catalog": all_items,
        "curatedRooms": curated_rooms,
        "newReleases": new_rel.get("items", all_items[:24]),
        "latestEpisodes": latest_eps.get("items", []),
    }
    (EDGE_DIR / "bootstrap.json").write_text(
        json.dumps(bootstrap, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"[EdgeBundle] Built successfully: catalog={len(all_items)}, "
        f"stream_keys={sum(len(b) for b in buckets)}, curated_rooms={len(curated_rooms)}"
    )


if __name__ == "__main__":
    main()
