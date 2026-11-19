from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

import httpx
from playwright.sync_api import Page
from websockets.sync.client import connect as ws_connect

ALLOWED_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/137.0.0.0 Safari/537.36"
)


def assert_local_url(raw_url: str) -> str:
    """Reject any non-loopback target URL so tests never hit watchlivo.online."""
    parsed = urlparse(str(raw_url).strip())
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        raise AssertionError(f"Unsupported URL scheme in {raw_url!r}")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_LOCAL_HOSTS:
        raise AssertionError(
            f"Refusing non-local URL {raw_url!r}; only {sorted(ALLOWED_LOCAL_HOSTS)} allowed"
        )
    return str(raw_url).strip().rstrip("/")


def to_ws_url(base_url: str, path: str) -> str:
    local_base = assert_local_url(base_url)
    if local_base.startswith("https://"):
        ws_base = "wss://" + local_base[len("https://"):]
    elif local_base.startswith("http://"):
        ws_base = "ws://" + local_base[len("http://"):]
    else:
        ws_base = local_base
    clean_path = path if path.startswith("/") else f"/{path}"
    return assert_local_url(f"{ws_base}{clean_path}")


def browser_headers(
    base_url: str,
    edge_token: str | None = None,
    bearer: str | None = None,
) -> dict[str, str]:
    local_base = assert_local_url(base_url)
    hdrs = {
        "User-Agent": BROWSER_UA,
        "Origin": local_base,
        "Referer": f"{local_base}/",
    }
    if edge_token:
        hdrs["X-Watchlivo-Token"] = edge_token
    if bearer:
        hdrs["Authorization"] = f"Bearer {bearer}"
    return hdrs


def fetch_edge_token(client: httpx.Client, base_url: str | None = None) -> str:
    headers = browser_headers(base_url) if base_url else {}
    resp = client.get("/api/rave/session-token", headers=headers)
    assert resp.status_code == 200, f"session-token failed: {resp.status_code} {resp.text}"
    data = resp.json()
    assert data.get("ok") is True and data.get("token"), f"bad session-token body: {data}"
    return str(data["token"])


def extract_meta_edge_token(html: str) -> str:
    m = re.search(r'<meta\s+name=["\']wl-edge-token["\']\s+content=["\']([^"\']+)["\']', html, re.I)
    return m.group(1).strip() if m else ""


def resolve_catalog_api(
    client: httpx.Client,
    edge_token: str,
    params: dict[str, Any],
    timeout: float = 35.0,
) -> httpx.Response:
    return client.get(
        "/api/rave/resolve-catalog",
        params=params,
        headers={"X-Watchlivo-Token": edge_token},
        timeout=timeout,
    )


def dismiss_cookie_banner(page: Page) -> None:
    btn = page.locator("#wl-cookie-accept-btn")
    try:
        if btn.count() > 0 and btn.first.is_visible():
            btn.first.click()
            page.locator("#wl-cookie-banner").wait_for(state="detached", timeout=3000)
    except Exception:
        pass


def wait_for_home_boot(
    page: Page,
    expect_edge_token: bool = True,
    timeout_ms: int = 18000,
) -> None:
    if expect_edge_token:
        page.wait_for_selector('meta[name="wl-edge-token"]', state="attached", timeout=timeout_ms)
    page.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=timeout_ms
    )
    page.locator('#lobby-box .tv-glass-card[data-room^="tv-"]').first.wait_for(
        state="visible", timeout=timeout_ms
    )
    dismiss_cookie_banner(page)


def close_modal_and_wait_detached(
    page: Page,
    use_escape: bool = False,
    timeout_ms: int = 5000,
) -> None:
    backdrop = page.locator("#popup-root .popup-backdrop")
    if backdrop.count() == 0:
        return
    if use_escape:
        page.keyboard.press("Escape")
    else:
        close_btn = page.locator('#popup-root .popup-close-x[aria-label="Kapat"]')
        if close_btn.count() > 0 and close_btn.first.is_visible():
            close_btn.first.click()
        else:
            page.keyboard.press("Escape")
    backdrop.wait_for(state="detached", timeout=timeout_ms)


def submit_home_search(page: Page, query: str, timeout_ms: int = 20000) -> None:
    search_input = page.locator('#home-selection .home-search input[aria-label="Ara"]')
    search_btn = page.locator('#home-selection .home-search button.btn.primary')
    search_input.fill(query)
    if query.strip():
        search_btn.click()
        page.locator(
            "#home-selection .super-results .poster.catalog-card, "
            "#home-selection .super-results .lobby-empty"
        ).first.wait_for(state="visible", timeout=timeout_ms)
    else:
        search_btn.click()


def leave_curated_room_and_wait_home(page: Page, timeout_ms: int = 12000) -> None:
    """Click #nav-leave-room in a curated room, confirm the #popup-root modal, and wait for #home-selection."""
    page.locator("#nav-leave-room").click()
    confirm_btn = page.locator("#popup-root .popup-options button.btn.primary").first
    confirm_btn.wait_for(state="visible", timeout=5000)
    confirm_btn.click()
    page.locator("#popup-root .popup-backdrop").wait_for(state="detached", timeout=5000)
    page.locator('#home-selection .home-search input[aria-label="Ara"]').wait_for(
        state="visible", timeout=timeout_ms
    )


def wait_for_video_ready(
    page: Page,
    timeout_ms: int = 25000,
    require_decoded: bool = True,
) -> dict[str, Any]:
    page.wait_for_function(
        """(requireDecoded) => {
            const v = document.querySelector('#video-frame .player-host > video');
            if (!v) return false;
            const decoded = v.readyState >= 2 && (v.videoWidth > 0 || v.duration > 0);
            if (requireDecoded) return decoded;
            return decoded || Boolean(v.currentSrc || v.src);
        }""",
        arg=require_decoded,
        timeout=timeout_ms,
    )
    return page.evaluate(
        """() => {
            const v = document.querySelector('#video-frame .player-host > video');
            return v ? {
                readyState: v.readyState,
                videoWidth: v.videoWidth,
                videoHeight: v.videoHeight,
                duration: Number.isFinite(v.duration) ? v.duration : 0,
                src: v.currentSrc || v.getAttribute('src') || '',
            } : {};
        }"""
    )


def ws_connect_init(
    ws_url: str,
    origin: str,
    timeout: float = 10.0,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Connect to room WebSocket, receive init frame, and test ping->pong."""
    assert_local_url(ws_url)
    with ws_connect(
        ws_url,
        origin=origin,
        user_agent_header=BROWSER_UA,
        open_timeout=timeout,
        close_timeout=5.0,
    ) as ws:
        raw_init = ws.recv(timeout=timeout)
        init_pkt = json.loads(raw_init)
        ws.send(json.dumps({"type": "ping", "t0": 1}))
        pong_pkt = None
        for _ in range(5):
            raw_next = ws.recv(timeout=timeout)
            msg = json.loads(raw_next)
            if msg.get("type") == "pong":
                pong_pkt = msg
                break
        return init_pkt, pong_pkt
