# -*- coding: utf-8 -*-
import sys
import io
import re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

print("Starting Option B implementation for Netflix...")

# -------------------------------------------------------------
# 1. PATCH server.py: Add netflix_bridge_proxy_endpoint & routes
# -------------------------------------------------------------
SERVER_PY = "server.py"
with open(SERVER_PY, "r", encoding="utf-8") as f:
    server_code = f.read()

NETFLIX_ENDPOINT_CODE = '''_NETFLIX_BRIDGE_LIMIT = RateLimiter(600, 60.0, name="netflix_bridge")

_NETFLIX_BRIDGE_INJECTED_JS = """<script id="watchlivo-netflix-bridge-agent">
(function() {
  console.log('[Watchlivo Bridge] Active in Netflix context');
  
  // 1. Monkey-patch fetch and XMLHttpRequest for relative routes
  const origFetch = window.fetch;
  window.fetch = function(resource, init) {
    try {
      if (typeof resource === 'string') {
        if (resource.startsWith('https://www.netflix.com/')) {
          resource = resource.replace('https://www.netflix.com/', '/api/netflix-bridge/');
        } else if (resource.startsWith('/') && !resource.startsWith('/api/netflix-bridge')) {
          resource = '/api/netflix-bridge' + resource;
        }
      } else if (resource && resource.url) {
        let u = resource.url;
        if (u.startsWith('https://www.netflix.com/')) {
          u = u.replace('https://www.netflix.com/', '/api/netflix-bridge/');
          resource = new Request(u, resource);
        } else if (u.startsWith('/') && !u.startsWith('/api/netflix-bridge')) {
          u = '/api/netflix-bridge' + u;
          resource = new Request(u, resource);
        }
      }
    } catch (_) {}
    return origFetch.call(this, resource, init);
  };

  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try {
      if (typeof url === 'string') {
        if (url.startsWith('https://www.netflix.com/')) {
          url = url.replace('https://www.netflix.com/', '/api/netflix-bridge/');
        } else if (url.startsWith('/') && !url.startsWith('/api/netflix-bridge')) {
          url = '/api/netflix-bridge' + url;
        }
      }
    } catch (_) {}
    return origXhrOpen.call(this, method, url, ...rest);
  };

  // 2. Intercept navigation and clicks to catch watch IDs
  function checkCurrentWatch() {
    try {
      const curUrl = location.href;
      const m = curUrl.match(/netflix\\.com\\/(?:[a-z-]+\\/)?watch\\/(\\d+)/i) || location.pathname.match(/\\/watch\\/(\\d+)/i);
      if (m) {
        const watchId = m[1];
        const titleEl = document.querySelector('.video-title, [data-uia=\"video-title\"], h4, h1') || document.title;
        const title = (typeof titleEl === 'string' ? titleEl : titleEl?.innerText) || document.title || ('Netflix #' + watchId);
        window.parent.postMessage({
          type: 'WATCHLIVO_NETFLIX_PICK',
          watchId: watchId,
          url: 'https://www.netflix.com/watch/' + watchId,
          title: String(title).replace(' - Netflix', '').trim()
        }, '*');
      }
    } catch (_) {}
  }

  const origPushState = history.pushState;
  history.pushState = function() {
    origPushState.apply(this, arguments);
    setTimeout(checkCurrentWatch, 300);
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function() {
    origReplaceState.apply(this, arguments);
    setTimeout(checkCurrentWatch, 300);
  };

  window.addEventListener('popstate', () => setTimeout(checkCurrentWatch, 300));
  document.addEventListener('click', () => setTimeout(checkCurrentWatch, 600), true);

  // 3. Monitor video playback for sync
  let hookedVideo = null;
  function hookVideo() {
    const v = document.querySelector('video');
    if (v && v !== hookedVideo) {
      hookedVideo = v;
      v.addEventListener('play', () => {
        window.parent.postMessage({ type: 'WATCHLIVO_NETFLIX_SYNC', action: 'play', currentTime: v.currentTime }, '*');
      });
      v.addEventListener('pause', () => {
        window.parent.postMessage({ type: 'WATCHLIVO_NETFLIX_SYNC', action: 'pause', currentTime: v.currentTime }, '*');
      });
      v.addEventListener('seeked', () => {
        window.parent.postMessage({ type: 'WATCHLIVO_NETFLIX_SYNC', action: 'seeked', currentTime: v.currentTime }, '*');
      });
    }
  }
  setInterval(hookVideo, 1000);

  // 4. Listen for commands from parent Watchlivo window
  window.addEventListener('message', (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    const v = document.querySelector('video');
    if (!v) return;
    if (ev.data.action === 'play') v.play();
    if (ev.data.action === 'pause') v.pause();
    if (ev.data.action === 'seek' && typeof ev.data.time === 'number') {
      if (Math.abs(v.currentTime - ev.data.time) > 1.2) {
        v.currentTime = ev.data.time;
      }
    }
  });

  window.parent.postMessage({ type: 'WATCHLIVO_NETFLIX_READY', url: location.href }, '*');
})();
</script>"""


async def netflix_bridge_proxy_endpoint(request: Request) -> Response:
    """Rave-parity Option B: In-browser reverse proxy for Netflix web session."""
    if request.method == "OPTIONS":
        return Response(
            b"",
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Cookie",
                "Access-Control-Allow-Credentials": "true",
            },
        )

    allowed, _ = _NETFLIX_BRIDGE_LIMIT.hit(client_ip(request))
    if not allowed:
        return JSONResponse({"error": "Rate limit exceeded on netflix bridge"}, status_code=429)

    rest = request.path_params.get("rest", "").strip("/")
    if not rest or rest in ("login", "browse"):
        target_path = rest if rest else "browse"
    else:
        target_path = rest

    target_url = f"https://www.netflix.com/{target_path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    from curl_cffi import requests as cffi_requests

    fwd_headers = {
        "User-Agent": request.headers.get("user-agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": request.headers.get("accept") or "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": request.headers.get("accept-language") or "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
    }

    client_cookie = request.headers.get("cookie", "")
    if client_cookie:
        fwd_headers["Cookie"] = client_cookie

    req_body = await request.body() if request.method in ("POST", "PUT", "PATCH") else None
    if req_body and "content-type" in request.headers:
        fwd_headers["Content-Type"] = request.headers["content-type"]

    try:
        def _fetch_sync():
            return cffi_requests.request(
                method=request.method,
                url=target_url,
                headers=fwd_headers,
                data=req_body,
                impersonate="chrome124",
                allow_redirects=True,
                timeout=20,
            )

        resp = await asyncio.to_thread(_fetch_sync)
    except Exception as exc:
        return JSONResponse({"error": f"Netflix proxy connection error: {str(exc)}"}, status_code=502)

    resp_content = resp.content
    content_type = resp.headers.get("content-type", "")

    # Inject bridge script into HTML pages
    if "text/html" in content_type.lower():
        html_str = resp.text
        head_tag_idx = html_str.lower().find("<head")
        if head_tag_idx != -1:
            close_head = html_str.find(">", head_tag_idx)
            if close_head != -1:
                html_str = html_str[:close_head+1] + _NETFLIX_BRIDGE_INJECTED_JS + html_str[close_head+1:]
        else:
            html_str = _NETFLIX_BRIDGE_INJECTED_JS + html_str
        resp_content = html_str.encode("utf-8", errors="replace")

    out_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": "true",
        "X-Frame-Options": "ALLOWALL",
        "Content-Security-Policy": "frame-ancestors *; default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; media-src * blob: data:;",
    }
    if content_type:
        out_headers["Content-Type"] = content_type

    cookie_headers = []
    for hk, hv in resp.headers.items():
        if hk.lower() == "set-cookie":
            rewritten_c = re.sub(r'(?i)\bdomain=[^;]+;?\s*', '', hv)
            cookie_headers.append(rewritten_c)

    response = Response(
        content=resp_content,
        status_code=resp.status_code,
        headers=out_headers,
    )
    for c in cookie_headers:
        response.headers.append("set-cookie", c)

    return response
'''

# Insert endpoint before def _is_admin_request
target_pos = server_code.find("def _is_admin_request(request: Request) -> bool:")
if target_pos != -1:
    server_code = server_code[:target_pos] + NETFLIX_ENDPOINT_CODE + "\n\n" + server_code[target_pos:]
    print("Added netflix_bridge_proxy_endpoint in server.py")
else:
    print("Could not find target _is_admin_request in server.py")

# Add routes
target_route = 'Route("/manifest.json", manifest_json, methods=["GET", "HEAD"]),'
routes_to_add = '''Route("/api/netflix-bridge", netflix_bridge_proxy_endpoint, methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"]),
        Route("/api/netflix-bridge/{rest:path}", netflix_bridge_proxy_endpoint, methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"]),
        '''
if target_route in server_code:
    server_code = server_code.replace(target_route, routes_to_add + target_route, 1)
    print("Added /api/netflix-bridge routes in server.py")
else:
    print("Could not find target route in server.py")

with open(SERVER_PY, "w", encoding="utf-8") as f:
    f.write(server_code)

print("server.py updated successfully!")
