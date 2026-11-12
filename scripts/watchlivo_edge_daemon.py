import io
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO_DIR / "workers" / "ha-gateway"
STATE_DIR = Path.home() / ".watchlivo"
CONFIG_PATH = STATE_DIR / "runtime_config.json"
STATUS_PATH = STATE_DIR / "daemon_status.json"
LOG_PATH = STATE_DIR / "daemon.log"
CLOUDFLARED_EXE = r"C:\Program Files (x86)\cloudflared\cloudflared.exe"
SSH_EXE = r"C:\Windows\System32\OpenSSH\ssh.exe"
CURL_EXE = r"C:\Windows\System32\curl.exe"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

STATE_DIR.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}\n"
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 5 * 1024 * 1024:
            LOG_PATH.write_text(line, encoding="utf-8")
        else:
            with open(LOG_PATH, "a", encoding="utf-8", errors="replace") as f:
                f.write(line)
    except Exception:
        pass
    try:
        if sys.stdout is not None and hasattr(sys.stdout, "write"):
            sys.stdout.write(line)
            sys.stdout.flush()
    except Exception:
        pass


def acquire_single_instance_lock(lock_port: int = 48081) -> socket.socket | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", lock_port))
        s.listen(1)
        return s
    except OSError:
        s.close()
        return None


def load_runtime_config() -> dict:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Missing runtime config: {CONFIG_PATH}")
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def wait_local_server(port: int = 8080, timeout_sec: float = 30.0) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def start_uvicorn(app_env: dict, port: int = 8080) -> subprocess.Popen:
    env = os.environ.copy()
    env.update({str(k): str(v) for k, v in app_env.items() if v is not None})
    py_exe = sys.executable
    if py_exe.lower().endswith("pythonw.exe"):
        cand = Path(py_exe).with_name("python.exe")
        if cand.exists():
            py_exe = str(cand)
    cmd = [
        py_exe,
        "-m",
        "uvicorn",
        "server:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--proxy-headers",
        "--forwarded-allow-ips=*",
    ]
    return subprocess.Popen(
        cmd,
        cwd=str(REPO_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=NO_WINDOW,
    )


def start_tunnel(provider: str, port: int = 8080) -> tuple[subprocess.Popen, str]:
    found = {"url": ""}
    if provider == "cloudflared" and Path(CLOUDFLARED_EXE).exists():
        cmd = [CLOUDFLARED_EXE, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"]
        rx = re.compile(r"(https://[a-z0-9-]+\.trycloudflare\.com)")
    else:
        cmd = [
            SSH_EXE,
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ExitOnForwardFailure=yes",
            "-R",
            f"80:127.0.0.1:{port}",
            "nokey@localhost.run",
        ]
        rx = re.compile(r"(https://[a-z0-9-]+\.lhr\.life)")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=NO_WINDOW,
    )

    def _reader():
        assert proc.stdout is not None
        for line in proc.stdout:
            m = rx.search(line)
            if m and not found["url"]:
                found["url"] = m.group(1)

    threading.Thread(target=_reader, daemon=True).start()
    deadline = time.time() + 28.0
    while time.time() < deadline and not found["url"]:
        if proc.poll() is not None:
            break
        time.sleep(0.3)
    return proc, found["url"]


def deploy_gateway_and_purge(cfg: dict, tunnel_url: str) -> bool:
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = cfg["cf_token"]
    env["CLOUDFLARE_ACCOUNT_ID"] = cfg["cf_account"]
    cmd = [
        "npx.cmd",
        "wrangler",
        "deploy",
        "--var",
        f"SECONDARY_ORIGIN:{tunnel_url}",
        "--var",
        "FORCE_SECONDARY:1",
    ]
    res = subprocess.run(
        cmd,
        cwd=str(WORKER_DIR),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=NO_WINDOW,
    )
    if res.returncode != 0:
        log(f"[Daemon] Wrangler deploy error: {(res.stderr or res.stdout)[-300:]}")
        return False
    try:
        req = urllib.request.Request(
            f"https://api.cloudflare.com/client/v4/zones/{cfg['zone_id']}/purge_cache",
            data=json.dumps({"purge_everything": True}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg['cf_token']}"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=15).read()
    except Exception:
        pass
    return True


def probe_public_domain() -> bool:
    for _ in range(5):
        try:
            if Path(CURL_EXE).exists():
                res = subprocess.run(
                    [CURL_EXE, "-s", "-f", "--max-time", "12", "https://watchlivo.online/api/health"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=NO_WINDOW,
                )
                if res.returncode == 0 and '"ok":true' in res.stdout.replace(" ", ""):
                    return True
            req = urllib.request.Request("https://watchlivo.online/api/health", headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"})
            with urllib.request.urlopen(req, timeout=12) as r:
                body = r.read().decode("utf-8", errors="replace")
                if r.status == 200 and '"ok"' in body:
                    return True
        except Exception:
            pass
        time.sleep(2.0)
    return False


def main() -> None:
    lock_sock = acquire_single_instance_lock(48081)
    if lock_sock is None:
        log("[Daemon] Another instance of Watchlivo Edge Daemon is already running (port 48081 locked). Exiting.")
        return

    cfg = load_runtime_config()
    port = 8080
    uvicorn_proc = None
    tunnel_proc = None
    preferred_provider = "cloudflared"
    active_url = ""
    consecutive_probe_failures = 0

    log("[Daemon] Watchlivo Persistent Edge Daemon started (PID=%d)." % os.getpid())

    while True:
        try:
            if uvicorn_proc is None or uvicorn_proc.poll() is not None:
                if not wait_local_server(port=port, timeout_sec=1.5):
                    log("[Daemon] Starting local Watchlivo ASGI server on 127.0.0.1:8080...")
                    uvicorn_proc = start_uvicorn(cfg["app_env"], port=port)
                    if not wait_local_server(port=port, timeout_sec=30.0):
                        log("[Daemon] Local server failed healthcheck; retrying...")
                        try:
                            uvicorn_proc.terminate()
                        except Exception:
                            pass
                        uvicorn_proc = None
                        time.sleep(3.0)
                        continue
                log("[Daemon] Local ASGI server healthy (200 OK).")

            if tunnel_proc is None or tunnel_proc.poll() is not None or not active_url:
                providers = [preferred_provider, "localhost_run"] if preferred_provider == "cloudflared" else ["localhost_run", "cloudflared"]
                for provider in providers:
                    log(f"[Daemon] Provisioning edge tunnel via {provider}...")
                    t_proc, t_url = start_tunnel(provider, port=port)
                    if not t_url:
                        try:
                            t_proc.terminate()
                        except Exception:
                            pass
                        continue
                    log(f"[Daemon] Tunnel established ({provider}): {t_url}")
                    time.sleep(2.5)
                    if deploy_gateway_and_purge(cfg, t_url) and probe_public_domain():
                        tunnel_proc = t_proc
                        active_url = t_url
                        preferred_provider = provider
                        consecutive_probe_failures = 0
                        STATUS_PATH.write_text(
                            json.dumps(
                                {
                                    "ok": True,
                                    "pid": os.getpid(),
                                    "provider": provider,
                                    "tunnel_url": t_url,
                                    "ts": time.time(),
                                },
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                        log(f"[Daemon] LIVE ON PRODUCTION: https://watchlivo.online -> {t_url}")
                        break
                    log(f"[Daemon] Public domain probe via {provider} failed; switching provider...")
                    try:
                        t_proc.terminate()
                    except Exception:
                        pass

            time.sleep(20.0)
            if active_url:
                if probe_public_domain():
                    consecutive_probe_failures = 0
                else:
                    consecutive_probe_failures += 1
                    log(f"[Daemon] Public probe warning ({consecutive_probe_failures}/2)...")
                    if consecutive_probe_failures >= 2:
                        log("[Daemon] Public probe confirmed degradation; cycling tunnel...")
                        if tunnel_proc is not None:
                            try:
                                tunnel_proc.terminate()
                            except Exception:
                                pass
                        tunnel_proc = None
                        active_url = ""
                        consecutive_probe_failures = 0
        except Exception as exc:
            log(f"[Daemon] Loop error recovered: {exc}")
            time.sleep(5.0)


if __name__ == "__main__":
    main()
