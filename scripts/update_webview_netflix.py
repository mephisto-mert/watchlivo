import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

FILE_PATH = "static/js/players/webview.js"
with open(FILE_PATH, "r", encoding="utf-8") as f:
    content = f.read()

target_marker = "const isNf = /netflix\\.com/i.test(this.mediaUrl) || media?.provider === 'netflix';"
if target_marker not in content:
    target_marker = "const isNf = /netflix.com/i.test(this.mediaUrl) || media?.provider === 'netflix';"

print("Target found?", target_marker in content)

netflix_player_block = """    const isNf = /netflix.com/i.test(this.mediaUrl) || media?.provider === 'netflix';

    // Option B: Direct embedded Netflix playback inside room for web users (Rave parity)
    if (isNf && !this._isDesktop) {
      const matchNf = (this.mediaUrl || '').match(/watch\\/(\\d+)/i) || (media?.id || '').match(/netflix-(\\d+)/i) || [];
      const watchId = matchNf[1];
      const bridgePlayerUrl = watchId ? `/api/netflix-bridge/watch/${watchId}` : (this.mediaUrl.startsWith('/api/netflix-bridge') ? this.mediaUrl : `/api/netflix-bridge/browse`);

      this.container.replaceChildren();
      const wrap = document.createElement('div');
      wrap.className = 'netflix-bridge-embedded-player';
      wrap.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;background:#000;position:relative;overflow:hidden;';

      const bar = document.createElement('div');
      bar.className = 'netflix-bridge-top-bar';
      bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:rgba(10,10,14,0.95);border-bottom:1px solid rgba(229,9,20,0.3);font-size:12px;color:#cbd5e1;flex-shrink:0;z-index:10;';
      bar.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-weight:900;color:#e50914;letter-spacing:1px;font-size:13px;">NETFLIX</span>
          <span style="background:rgba(229,9,20,0.15);color:#f87171;padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px;">Rave Köprüsü (Canlı Senkron)</span>
          <span style="color:#94a3b8;">·</span>
          <span style="color:#ffffff;font-weight:700;">${media?.title || 'Netflix'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button id="nf-player-reload-btn" type="button" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;">🔄 Yenile</button>
          <button id="nf-player-popup-btn" type="button" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;">Ayrı Pencerede Aç ↗</button>
        </div>
      `;

      const iframe = document.createElement('iframe');
      iframe.id = 'watchlivo-netflix-video-frame';
      iframe.src = bridgePlayerUrl;
      iframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
      iframe.style.cssText = 'width:100%;flex:1;border:none;background:#000;';

      wrap.appendChild(bar);
      wrap.appendChild(iframe);
      this.container.appendChild(wrap);
      this.bridgeIframe = iframe;

      const reloadBtn = bar.querySelector('#nf-player-reload-btn');
      if (reloadBtn) reloadBtn.onclick = () => { iframe.src = iframe.src; };

      const popupBtn = bar.querySelector('#nf-player-popup-btn');
      if (popupBtn) popupBtn.onclick = () => {
        window.open(this.mediaUrl || `https://www.netflix.com/watch/${watchId}`, 'vortex_netflix_pop', 'width=1280,height=760');
      };

      this.timer = setInterval(() => {
        const cur = this.getTime();
        this.state.t = cur;
        this.state.d = this.duration;
        this.state.paused = this.paused;
      }, 500);

      this.events.onBuffering?.(false);
      this.events.onReady?.();
      if (shouldPlay) this.events.onPlay?.();
      return;
    }
"""

if target_marker in content:
    content = content.replace(target_marker, netflix_player_block, 1)
    print("Replaced netflix player block in webview.js")
else:
    print("target_marker not found")

# Also in _broadcastSync, ensure this.bridgeIframe?.contentWindow gets notified
sync_marker = "try { this.targetWindow?.postMessage(packet, '*'); } catch (_) {}"
sync_replacement = """try { this.targetWindow?.postMessage(packet, '*'); } catch (_) {}
    try { this.bridgeIframe?.contentWindow?.postMessage({ action, time: this.getTime(), currentTime: this.getTime() }, '*'); } catch (_) {}"""

if sync_marker in content:
    content = content.replace(sync_marker, sync_replacement, 1)
    print("Added bridgeIframe sync to _broadcastSync")

with open(FILE_PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("webview.js updated successfully!")
