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


def resolve_uvicorn_python() -> str:
    candidates = [
        sys.executable,
        r"C:\Users\pc\AppData\Local\Python\pythoncore-3.14-64\python.exe",
        r"C:\Users\pc\AppData\Local\Programs\Python\Python312\python.exe",
    ]
    for raw in candidates:
        if not raw:
            continue
        p = Path(raw)
        if p.name.lower() == "pythonw.exe":
            alt = p.with_name("python.exe")
            if alt.exists():
                p = alt
        if not p.exists():
            continue
        try:
            chk = subprocess.run(
                [str(p), "-c", "import uvicorn"],
                capture_output=True,
                timeout=5,
                creationflags=NO_WINDOW,
            )
            if chk.returncode == 0:
                return str(p)
        except Exception:
            pass
    return sys.executable


def ensure_ssh_key() -> Path:
    key_path = STATE_DIR / "id_ed25519"
    if not key_path.exists():
        keygen = Path(SSH_EXE).with_name("ssh-keygen.exe")
        if keygen.exists():
            subprocess.run(
                [str(keygen), "-t", "ed25519", "-N", "", "-f", str(key_path)],
                capture_output=True,
                timeout=10,
                creationflags=NO_WINDOW,
            )
    return key_path


def start_uvicorn(app_env: dict, port: int = 8080) -> subprocess.Popen:
    env = os.environ.copy()
    env.update({str(k): str(v) for k, v in app_env.items() if v is not None})
    py_exe = resolve_uvicorn_python()
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
    wait_sec = 22.0
    if provider == "cloudflared" and Path(CLOUDFLARED_EXE).exists():
        cmd = [
            CLOUDFLARED_EXE,
            "tunnel",
            "--url",
            f"http://127.0.0.1:{port}",
            "--protocol",
            "http2",
            "--ha-connections",
            "4",
            "--no-autoupdate",
        ]
        rx = re.compile(r"(https://[a-z0-9-]+\.trycloudflare\.com)")
    elif provider == "pinggy":
        key_path = ensure_ssh_key()
        cmd = [
            SSH_EXE,
            "-T",
            "-p",
            "443",
            "-i",
            str(key_path),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ExitOnForwardFailure=yes",
            f"-R0:127.0.0.1:{port}",
            "free.pinggy.io",
        ]
        rx = re.compile(r"(https://[a-z0-9.-]+\.free\.pinggy\.net|https://[a-z0-9.-]+\.pinggy-free\.link)")
        wait_sec = 12.0
    else:
        cmd = [
            SSH_EXE,
            "-T",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=6",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ExitOnForwardFailure=yes",
            "-R",
            f"80:127.0.0.1:{port}",
            "nokey@localhost.run",
        ]
        rx = re.compile(r"(https://[a-z0-9-]+\.lhr\.life)")
        wait_sec = 8.0

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
    deadline = time.time() + wait_sec
    while time.time() < deadline and not found["url"]:
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    return proc, found["url"]


def deploy_gateway_and_purge(cfg: dict, secondary_url: str, tertiary_url: str = "") -> bool:
    if not (WORKER_DIR / "public" / "_edge" / "bootstrap.json").exists():
        subprocess.run(
            [resolve_uvicorn_python(), str(REPO_DIR / "scripts" / "build_edge_bundle.py")],
            cwd=str(REPO_DIR),
            capture_output=True,
            creationflags=NO_WINDOW,
        )
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = cfg["cf_token"]
    env["CLOUDFLARE_ACCOUNT_ID"] = cfg["cf_account"]
    cmd = [
        "npx.cmd",
        "wrangler",
        "deploy",
        "--var",
        f"SECONDARY_ORIGIN:{secondary_url}",
        "--var",
        "FORCE_SECONDARY:1",
    ]
    if tertiary_url and tertiary_url != secondary_url:
        cmd += ["--var", f"TERTIARY_ORIGIN:{tertiary_url}"]
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
    cf_proc = None
    cf_url = ""
    lhr_proc = None
    lhr_url = ""
    lhr_started_at = 0.0
    backup_retry_after = 0.0
    deployed_pair = ("", "")
    consecutive_probe_failures = 0

    log("[Daemon] Watchlivo Persistent Dual-Tunnel Edge Daemon started (PID=%d)." % os.getpid())

    while True:
        try:
            if uvicorn_proc is None or uvicorn_proc.poll() is not None:
                if not wait_local_server(port=port, timeout_sec=1.5):
                    log("[Daemon] Starting local Watchlivo ASGI server on 127.0.0.1:8080...")
                    cfg = load_runtime_config()
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

            if cf_proc is None or cf_proc.poll() is not None or not cf_url:
                log("[Daemon] Provisioning HTTP/2 HA edge tunnel via cloudflared...")
                p, u = start_tunnel("cloudflared", port=port)
                if u:
                    cf_proc, cf_url = p, u
                    log(f"[Daemon] Cloudflared HTTP/2 tunnel ready: {cf_url}")
                    # Immediately cut over production before waiting on secondary SSH backup tunnel
                    if not deployed_pair[0] and deploy_gateway_and_purge(cfg, cf_url, lhr_url) and probe_public_domain():
                        deployed_pair = (cf_url, lhr_url if lhr_url else "")
                        consecutive_probe_failures = 0
                        log(f"[Daemon] FAST CUTOVER LIVE: https://watchlivo.online -> {cf_url}")
                else:
                    try:
                        p.terminate()
                    except Exception:
                        pass
                    cf_proc, cf_url = None, ""

            now_ts = time.time()
            backup_expired = bool(lhr_url and lhr_started_at and (now_ts - lhr_started_at > 3000.0))
            if (lhr_proc is None or lhr_proc.poll() is not None or not lhr_url or backup_expired) and now_ts >= backup_retry_after:
                old_backup = lhr_proc
                log("[Daemon] Provisioning Port-443 HTTPS backup tunnel (Pinggy/LHR)...")
                p2, u2 = start_tunnel("pinggy", port=port)
                if not u2:
                    try:
                        p2.terminate()
                    except Exception:
                        pass
                    p2, u2 = start_tunnel("localhost_run", port=port)
                if u2:
                    if old_backup is not None and old_backup is not p2:
                        try:
                            old_backup.terminate()
                        except Exception:
                            pass
                    lhr_proc, lhr_url = p2, u2
                    lhr_started_at = time.time()
                    backup_retry_after = 0.0
                    log(f"[Daemon] Port-443 backup tunnel ready: {lhr_url}")
                else:
                    try:
                        p2.terminate()
                    except Exception:
                        pass
                    if not backup_expired:
                        lhr_proc, lhr_url = None, ""
                    backup_retry_after = time.time() + 180.0
                    log("[Daemon] Backup SSH tunnel unavailable; retrying in 180s without stalling primary.")

            sec_origin = cf_url or lhr_url
            tert_origin = lhr_url if (cf_url and lhr_url) else ""

            if sec_origin and (sec_origin, tert_origin) != deployed_pair:
                time.sleep(2.0)
                if deploy_gateway_and_purge(cfg, sec_origin, tert_origin) and probe_public_domain():
                    deployed_pair = (sec_origin, tert_origin)
                    consecutive_probe_failures = 0
                    STATUS_PATH.write_text(
                        json.dumps(
                            {
                                "ok": True,
                                "pid": os.getpid(),
                                "secondary_origin": sec_origin,
                                "tertiary_origin": tert_origin,
                                "ts": time.time(),
                            },
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                    log(f"[Daemon] LIVE ON PRODUCTION: https://watchlivo.online -> {sec_origin} (failover: {tert_origin or 'none'})")
                else:
                    log("[Daemon] Public probe failed after deploy; swapping primary/backup order...")
                    if lhr_url and sec_origin == cf_url and deploy_gateway_and_purge(cfg, lhr_url, cf_url) and probe_public_domain():
                        deployed_pair = (sec_origin, tert_origin)
                        consecutive_probe_failures = 0
                        log(f"[Daemon] LIVE ON PRODUCTION (LHR Primary): https://watchlivo.online -> {lhr_url}")

            time.sleep(20.0)
            if deployed_pair[0]:
                if probe_public_domain():
                    consecutive_probe_failures = 0
                else:
                    consecutive_probe_failures += 1
                    log(f"[Daemon] Public probe warning ({consecutive_probe_failures}/2)...")
                    if consecutive_probe_failures >= 2:
                        log("[Daemon] Public probe confirmed degradation; cycling tunnels...")
                        for tp in (cf_proc, lhr_proc):
                            if tp is not None:
                                try:
                                    tp.terminate()
                                except Exception:
                                    pass
                        cf_proc, cf_url = None, ""
                        lhr_proc, lhr_url = None, ""
                        deployed_pair = ("", "")
                        consecutive_probe_failures = 0
        except Exception as exc:
            log(f"[Daemon] Loop error recovered: {exc}")
            time.sleep(5.0)


if __name__ == "__main__":
    main()
