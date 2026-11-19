from __future__ import annotations

import atexit
from contextlib import contextmanager
from dataclasses import dataclass, field
import glob
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Iterator
from urllib.parse import urlparse

import httpx
import pytest
from playwright.sync_api import Browser, BrowserContext, ConsoleMessage, Page, Request, Response, sync_playwright

from helpers import BROWSER_UA, assert_local_url, browser_headers, fetch_edge_token

REPO_ROOT = Path(__file__).resolve().parents[2]

ALLOWED_EXTERNAL_CDN_HOSTS = {
    "static.cloudflareinsights.com",
    "www.google-analytics.com",
    "www.googletagmanager.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
}

ALLOWED_YT_WIDGET_HOSTS = {
    "www.youtube-nocookie.com",
    "www.youtube.com",
    "s.ytimg.com",
}

OFFLINE_NET_ERRORS = (
    "ERR_NAME_NOT_RESOLVED",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NETWORK_CHANGED",
)

_MANAGED_PROCESSES: list[tuple[subprocess.Popen, str | None]] = []


def _kill_process_tree(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            text=True,
        )
    else:
        import signal
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except Exception:
            pass


def _cleanup_managed() -> None:
    for proc, tmp_dir in list(_MANAGED_PROCESSES):
        try:
            if proc.poll() is None:
                _kill_process_tree(proc.pid)
                try:
                    proc.wait(timeout=8)
                except Exception:
                    pass
        except Exception:
            pass
        if tmp_dir:
            for _ in range(5):
                try:
                    shutil.rmtree(tmp_dir, ignore_errors=False)
                    break
                except FileNotFoundError:
                    break
                except Exception:
                    time.sleep(0.25)
            shutil.rmtree(tmp_dir, ignore_errors=True)
    _MANAGED_PROCESSES.clear()


atexit.register(_cleanup_managed)


def _is_first_party(url_str: str) -> bool:
    if not url_str:
        return False
    if url_str.startswith("/"):
        return True
    parsed = urlparse(url_str)
    host = (parsed.hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1"}


def _host_of(url_str: str) -> str:
    try:
        return (urlparse(url_str).hostname or "").lower()
    except Exception:
        return ""


@dataclass
class ExpectedHttpError:
    method: str | None
    path_contains: str
    status: int | None

    def matches(self, method: str, url: str, status: int) -> bool:
        if self.method and method.upper() != self.method.upper():
            return False
        if self.path_contains and self.path_contains not in url:
            return False
        if self.status is not None and status != self.status:
            return False
        return True


@dataclass
class HygieneCollector:
    """Strict first-party vs third-party browser console & network hygiene collector."""

    page_errors: list[str] = field(default_factory=list)
    console_errors: list[tuple[str, str]] = field(default_factory=list)
    request_failures: list[tuple[str, str, str]] = field(default_factory=list)
    http_errors: list[tuple[int, str, str]] = field(default_factory=list)
    all_requests: list[tuple[str, str]] = field(default_factory=list)
    _active_http_rules: list[ExpectedHttpError] = field(default_factory=list)
    _allowed_console_http: list[tuple[str, str, int | None]] = field(default_factory=list)
    _allowed_third_party_urls: set[str] = field(default_factory=set)

    @contextmanager
    def allow_http_error(
        self,
        path_contains: str,
        status: int | None = None,
        method: str | None = None,
    ) -> Iterator[None]:
        rule = ExpectedHttpError(method=method, path_contains=path_contains, status=status)
        self._active_http_rules.append(rule)
        try:
            yield
        finally:
            try:
                self._active_http_rules.remove(rule)
            except ValueError:
                pass

    def _matching_active_rule(self, method: str, url: str, status: int) -> ExpectedHttpError | None:
        for r in self._active_http_rules:
            if r.matches(method, url, status):
                return r
        return None

    def _is_expected_http(self, method: str, url: str, status: int) -> bool:
        return self._matching_active_rule(method, url, status) is not None

    def _is_allowed_third_party_failure(self, url: str, failure_text: str) -> bool:
        if "od5S7r2v306B2eR0E5t6vP8K2wG.jpg" in url:
            return False
        host = _host_of(url)
        if _is_first_party(url):
            return False
        if host in ALLOWED_EXTERNAL_CDN_HOSTS:
            return True
        if host in ALLOWED_YT_WIDGET_HOSTS:
            return True
        if host == "image.tmdb.org" and any(e in failure_text for e in OFFLINE_NET_ERRORS):
            return True
        return False

    def _is_allowed_third_party_console(self, text: str, loc_url: str) -> bool:
        host = _host_of(loc_url)
        if _is_first_party(loc_url):
            return False
        if host in ALLOWED_EXTERNAL_CDN_HOSTS:
            return True
        if host in ALLOWED_YT_WIDGET_HOSTS:
            return True
        if (
            host in ALLOWED_YT_WIDGET_HOSTS
            and "postMessage" in text
            and "youtube-nocookie.com" in text
            and "DOMWindow" in text
        ):
            return True
        if "Failed to load resource" in text:
            if loc_url in self._allowed_third_party_urls:
                return True
            if host and host in (ALLOWED_EXTERNAL_CDN_HOSTS | ALLOWED_YT_WIDGET_HOSTS):
                return True
        return False

    def attach(self, page: Page) -> None:
        def on_pageerror(exc: Exception) -> None:
            self.page_errors.append(str(exc))

        def on_console(msg: ConsoleMessage) -> None:
            if msg.type != "error":
                return
            loc_url = ""
            try:
                loc_url = msg.location.get("url", "") or ""
            except Exception:
                loc_url = ""
            txt = msg.text or ""
            if self._is_allowed_third_party_console(txt, loc_url):
                return
            self.console_errors.append((txt, loc_url))

        def on_request(req: Request) -> None:
            self.all_requests.append((req.method, req.url))

        def on_requestfailed(req: Request) -> None:
            failure = req.failure or ""
            if isinstance(failure, dict):
                failure_txt = str(failure.get("errorText") or failure)
            else:
                failure_txt = str(failure)
            if self._is_allowed_third_party_failure(req.url, failure_txt):
                self._allowed_third_party_urls.add(req.url)
                return
            if "ERR_ABORTED" in failure_txt and not _is_first_party(req.url):
                return
            if "ERR_ABORTED" in failure_txt and any(
                p in req.url
                for p in ("/api/rave/stream?", "/api/rave/stream-proxy?", "/api/rave/stream-manifest", "/api/rave/resolve-catalog?")
            ):
                # Intentional cancellation (hls.js level switch/destroy or AbortController on episode/channel change).
                return
            self.request_failures.append((req.url, req.method, failure_txt))

        def on_response(resp: Response) -> None:
            status = resp.status
            if status < 400:
                return
            url = resp.url
            method = resp.request.method
            if _is_first_party(url):
                rule = self._matching_active_rule(method, url, status)
                if rule is not None:
                    self._allowed_console_http.append((url, rule.path_contains, status))
                    return
                self.http_errors.append((status, method, url))
            else:
                host = _host_of(url)
                if host in (ALLOWED_EXTERNAL_CDN_HOSTS | ALLOWED_YT_WIDGET_HOSTS):
                    self._allowed_third_party_urls.add(url)
                elif "od5S7r2v306B2eR0E5t6vP8K2wG.jpg" in url:
                    self.http_errors.append((status, method, url))

        page.on("pageerror", on_pageerror)
        page.on("console", on_console)
        page.on("request", on_request)
        page.on("requestfailed", on_requestfailed)
        page.on("response", on_response)

    def first_party_http_errors(self) -> list[tuple[int, str, str]]:
        return [e for e in self.http_errors if _is_first_party(e[2])]

    def assert_clean(
        self,
        ignore_console_if_expected_http: bool = True,
        allow_third_party_request_failures: bool = False,
    ) -> None:
        fp_http = self.first_party_http_errors()
        orb_http = [e for e in self.http_errors if "od5S7r2v306B2eR0E5t6vP8K2wG.jpg" in e[2]]
        assert not self.page_errors, f"Uncaught pageerror(s): {self.page_errors}"
        assert not fp_http, f"Unexpected first-party HTTP 4xx/5xx: {fp_http}"
        assert not orb_http, f"Unexpected broken Solo Leveling backdrop HTTP error(s): {orb_http}"

        unexpected_console = []
        for txt, loc in self.console_errors:
            if (
                ignore_console_if_expected_http
                and "Failed to load resource" in txt
                and _is_first_party(loc)
                and any(
                    (allowed_url == loc or (path_contains and path_contains in loc))
                    and (allowed_status is None or str(allowed_status) in txt)
                    for allowed_url, path_contains, allowed_status in self._allowed_console_http
                )
            ):
                continue
            unexpected_console.append((txt, loc))
        assert not unexpected_console, f"Unexpected console.error(s): {unexpected_console}"

        req_fails = self.request_failures
        if allow_third_party_request_failures:
            req_fails = [
                rf for rf in req_fails
                if _is_first_party(rf[0]) or "od5S7r2v306B2eR0E5t6vP8K2wG.jpg" in rf[0]
            ]
        assert not req_fails, f"Unexpected requestfailed event(s): {req_fails}"


def _wait_for_health(url: str, timeout_s: float = 30.0, proc: subprocess.Popen | None = None, log_path: Path | None = None) -> None:
    deadline = time.monotonic() + timeout_s
    headers = {"User-Agent": BROWSER_UA}
    last_err = ""
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:] if log_path and log_path.exists() else ""
            raise RuntimeError(f"Process exited prematurely with code {proc.returncode}.\n{tail}")
        try:
            r = httpx.get(f"{url}/api/health", headers=headers, follow_redirects=False, timeout=2.5)
            if r.status_code == 200:
                data = r.json()
                if data.get("ok") is True:
                    return
                last_err = f"health ok!=True: {data}"
            else:
                last_err = f"status={r.status_code} loc={r.headers.get('location')}"
        except Exception as exc:
            last_err = str(exc)
        time.sleep(0.4)
    tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:] if log_path and log_path.exists() else ""
    raise RuntimeError(f"Server at {url} did not become healthy within {timeout_s}s ({last_err}).\n{tail}")


def _is_watchlivo_already_up(url: str) -> bool:
    try:
        r = httpx.get(f"{url}/api/health", headers={"User-Agent": BROWSER_UA}, follow_redirects=False, timeout=1.5)
        return r.status_code == 200 and r.json().get("ok") is True
    except Exception:
        return False


def _format_host(host: str) -> str:
    return f"[{host}]" if ":" in host else host


def _is_port_in_use(host: str, port: int) -> bool:
    af = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(af, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def _pick_free_port(preferred_port: int, host: str = "127.0.0.1") -> int:
    if not _is_port_in_use(host, preferred_port):
        return preferred_port
    af = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(af, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="session")
def base_url() -> Iterator[str]:
    env_url = os.environ.get("WATCHLIVO_TEST_URL", "").strip()
    target = assert_local_url(env_url or "http://127.0.0.1:8785")
    if env_url and _is_watchlivo_already_up(target):
        yield target
        return

    parsed = urlparse(target)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8785
    if not env_url:
        port = _pick_free_port(port, host)
        target = f"http://{_format_host(host)}:{port}"
    elif _is_watchlivo_already_up(target):
        yield target
        return
    tmp_dir = tempfile.mkdtemp(prefix="watchlivo_e2e_wrangler_")
    log_path = Path(tmp_dir) / "wrangler.log"
    npx_bin = "npx.cmd" if os.name == "nt" else "npx"
    cmd = [
        npx_bin, "wrangler", "dev",
        "--config", "workers/ha-gateway/wrangler.toml",
        "--port", str(port),
        "--var", "FORCE_SECONDARY:1",
        "--var", "SECONDARY_ORIGIN:http://127.0.0.1:59999",
        "--var", "PROXY_SECRET:localdevsecret",
        "--persist-to", tmp_dir,
    ]
    log_fh = open(log_path, "w", encoding="utf-8", errors="replace")
    kwargs: dict = {
        "cwd": str(REPO_ROOT),
        "stdout": log_fh,
        "stderr": subprocess.STDOUT,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **kwargs)
    _MANAGED_PROCESSES.append((proc, tmp_dir))
    try:
        _wait_for_health(target, timeout_s=35.0, proc=proc, log_path=log_path)
        yield target
    finally:
        try:
            log_fh.close()
        except Exception:
            pass
        if proc.poll() is None:
            _kill_process_tree(proc.pid)
            try:
                proc.wait(timeout=10)
            except Exception:
                pass
        for _ in range(8):
            try:
                shutil.rmtree(tmp_dir, ignore_errors=False)
                break
            except FileNotFoundError:
                break
            except Exception:
                time.sleep(0.25)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        try:
            _MANAGED_PROCESSES.remove((proc, tmp_dir))
        except ValueError:
            pass


@pytest.fixture(scope="session")
def py_base_url() -> Iterator[str]:
    env_url = os.environ.get("WATCHLIVO_PY_URL", "").strip()
    target = assert_local_url(env_url or "http://127.0.0.1:8799")
    if env_url and _is_watchlivo_already_up(target):
        yield target
        return

    parsed = urlparse(target)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8799
    if not env_url:
        port = _pick_free_port(port, host)
        target = f"http://{_format_host(host)}:{port}"
    tmp_dir = tempfile.mkdtemp(prefix="watchlivo_e2e_py_")
    log_path = Path(tmp_dir) / "server.log"
    env = os.environ.copy()
    env["HOST"] = parsed.hostname or "127.0.0.1"
    env["PORT"] = str(port)
    env["WATCHLIVO_DB_PATH"] = str(Path(tmp_dir) / "e2e_rave.db")
    env["PROXY_SECRET"] = "localdevsecret"

    log_fh = open(log_path, "w", encoding="utf-8", errors="replace")
    kwargs: dict = {
        "cwd": str(REPO_ROOT),
        "env": env,
        "stdout": log_fh,
        "stderr": subprocess.STDOUT,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    proc = subprocess.Popen([sys.executable, "server.py"], **kwargs)
    _MANAGED_PROCESSES.append((proc, tmp_dir))
    try:
        _wait_for_health(target, timeout_s=25.0, proc=proc, log_path=log_path)
        yield target
    finally:
        try:
            log_fh.close()
        except Exception:
            pass
        if proc.poll() is None:
            _kill_process_tree(proc.pid)
            try:
                proc.wait(timeout=10)
            except Exception:
                pass
        for _ in range(8):
            try:
                shutil.rmtree(tmp_dir, ignore_errors=False)
                break
            except FileNotFoundError:
                break
            except Exception:
                time.sleep(0.25)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        try:
            _MANAGED_PROCESSES.remove((proc, tmp_dir))
        except ValueError:
            pass


@pytest.fixture(scope="session")
def api_client(base_url: str) -> Iterator[httpx.Client]:
    with httpx.Client(
        base_url=base_url,
        follow_redirects=False,
        timeout=25.0,
        headers=browser_headers(base_url),
    ) as client:
        yield client


@pytest.fixture(scope="function")
def edge_token(api_client: httpx.Client, base_url: str) -> str:
    return fetch_edge_token(api_client, base_url)


@pytest.fixture(scope="session")
def browser() -> Iterator[Browser]:
    with sync_playwright() as p:
        launched: Browser | None = None
        try:
            launched = p.chromium.launch(channel="chrome", headless=True)
        except Exception:
            local_app = os.environ.get("LOCALAPPDATA", "")
            candidates = sorted(
                glob.glob(os.path.join(local_app, "ms-playwright", "chromium*", "chrome-win*", "chrome.exe")),
                reverse=True,
            )
            for exe in candidates:
                try:
                    launched = p.chromium.launch(executable_path=exe, headless=True)
                    break
                except Exception:
                    continue
            if launched is None:
                launched = p.chromium.launch(headless=True)
        try:
            yield launched
        finally:
            launched.close()


def _create_isolated_page(
    browser: Browser,
    viewport: dict[str, int],
    has_touch: bool = False,
) -> tuple[BrowserContext, Page, HygieneCollector]:
    ctx = browser.new_context(
        viewport=viewport,
        has_touch=has_touch,
        user_agent=BROWSER_UA,
        ignore_https_errors=True,
    )
    page = ctx.new_page()
    hygiene = HygieneCollector()
    hygiene.attach(page)
    setattr(page, "hygiene", hygiene)
    return ctx, page, hygiene


@pytest.fixture(scope="function")
def page_session(browser: Browser) -> Iterator[Page]:
    ctx, page, _ = _create_isolated_page(browser, {"width": 1280, "height": 800}, has_touch=False)
    try:
        yield page
    finally:
        ctx.close()


@pytest.fixture(scope="function")
def mobile_page_session(browser: Browser) -> Iterator[Page]:
    ctx, page, _ = _create_isolated_page(browser, {"width": 390, "height": 844}, has_touch=True)
    try:
        yield page
    finally:
        ctx.close()


@pytest.fixture(scope="function")
def make_page(browser: Browser):
    contexts: list[BrowserContext] = []

    def _factory(width: int = 1280, height: int = 800, has_touch: bool = False) -> Page:
        ctx, page, _ = _create_isolated_page(browser, {"width": width, "height": height}, has_touch=has_touch)
        contexts.append(ctx)
        return page

    yield _factory
    for ctx in contexts:
        try:
            ctx.close()
        except Exception:
            pass
