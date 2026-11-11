import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

if getattr(sys.stdout, "buffer", None) is not None:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if getattr(sys.stderr, "buffer", None) is not None:
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

REPO_DIR = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO_DIR / "workers" / "ha-gateway"
STATE_DIR = Path.home() / ".watchlivo"
CONFIG_PATH = STATE_DIR / "runtime_config.json"
STATUS_PATH = STATE_DIR / "daemon_status.json"
CLOUDFLARED_EXE = r"C:\Program Files (x86)\cloudflared\cloudflared.exe"
SSH_EXE = r"C:\Windows\System32\OpenSSH\ssh.exe"


def load_runtime_config() -> dict:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Missing runtime config: {CONFIG_PATH}")
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def wait_local_server(port: int = 8080, timeout_sec: float = 25.0) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/app/version", timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def start_uvicorn(app_env: dict, port: int = 8080) -> subprocess.Popen:
    env = os.environ.copy()
    env.update({str(k): str(v) for k, v in app_env.items() if v is not None})
    cmd = [
        sys.executable,
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
    return subprocess.Popen(cmd, cwd=str(REPO_DIR), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
    )

    def _reader():
        assert proc.stdout is not None
        for line in proc.stdout:
            m = rx.search(line)
            if m and not found["url"]:
                found["url"] = m.group(1)

    threading.Thread(target=_reader, daemon=True).start()
    deadline = time.time() + 25.0
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
    res = subprocess.run(cmd, cwd=str(WORKER_DIR), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0:
        print("[Daemon] Wrangler deploy error:", (res.stderr or res.stdout)[-300:], flush=True)
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
    for _ in range(4):
        try:
            req = urllib.request.Request("https://watchlivo.online/api/app/version", headers={"User-Agent": "Watchlivo-Daemon/1.0"})
            with urllib.request.urlopen(req, timeout=12) as r:
                body = r.read().decode("utf-8", errors="replace")
                if r.status == 200 and "version" in body:
                    return True
        except Exception:
            pass
        time.sleep(2.0)
    return False


def main() -> None:
    cfg = load_runtime_config()
    port = 8080
    uvicorn_proc = None
    tunnel_proc = None
    preferred_provider = "cloudflared"
    active_url = ""

    while True:
        if uvicorn_proc is None or uvicorn_proc.poll() is not None:
            print("[Daemon] Starting local Watchlivo ASGI server on 127.0.0.1:8080...", flush=True)
            uvicorn_proc = start_uvicorn(cfg["app_env"], port=port)
            if not wait_local_server(port=port, timeout_sec=30.0):
                print("[Daemon] Local server failed healthcheck; retrying...", flush=True)
                try:
                    uvicorn_proc.terminate()
                except Exception:
                    pass
                uvicorn_proc = None
                time.sleep(3.0)
                continue
            print("[Daemon] Local ASGI server healthy (200 OK).", flush=True)

        if tunnel_proc is None or tunnel_proc.poll() is not None or not active_url:
            for provider in ([preferred_provider, "localhost_run"] if preferred_provider == "cloudflared" else ["localhost_run", "cloudflared"]):
                print(f"[Daemon] Provisioning edge tunnel via {provider}...", flush=True)
                t_proc, t_url = start_tunnel(provider, port=port)
                if not t_url:
                    try:
                        t_proc.terminate()
                    except Exception:
                        pass
                    continue
                print(f"[Daemon] Tunnel established ({provider}): {t_url}", flush=True)
                if deploy_gateway_and_purge(cfg, t_url) and probe_public_domain():
                    tunnel_proc = t_proc
                    active_url = t_url
                    preferred_provider = provider
                    STATUS_PATH.write_text(
                        json.dumps({"ok": True, "provider": provider, "tunnel_url": t_url, "ts": time.time()}, indent=2),
                        encoding="utf-8",
                    )
                    print(f"[Daemon] LIVE ON PRODUCTION: https://watchlivo.online -> {t_url}", flush=True)
                    break
                print(f"[Daemon] Public domain probe via {provider} failed (orange-to-orange or 5xx); switching provider...", flush=True)
                try:
                    t_proc.terminate()
                except Exception:
                    pass

        time.sleep(20.0)
        if active_url and not probe_public_domain():
            print("[Daemon] Public probe detected degradation; cycling tunnel...", flush=True)
            if tunnel_proc is not None:
                try:
                    tunnel_proc.terminate()
                except Exception:
                    pass
            tunnel_proc = None
            active_url = ""


if __name__ == "__main__":
    main()
