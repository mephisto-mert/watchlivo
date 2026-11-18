"""Tiny probe so network-dependent tests skip cleanly in sandboxed/offline CI."""
import functools
import urllib.request


@functools.lru_cache(maxsize=None)
def network_available(url: str = "https://itunes.apple.com/search?term=test&limit=1", timeout: float = 4.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= int(getattr(resp, "status", 200)) < 400
    except Exception:
        return False
