import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

with open("server.py", "rb") as f:
    text = f.read()

is_crlf = b"\r\n" in text
nl = b"\r\n" if is_crlf else b"\n"

# 1. Define _STREAM_LOCKS above rave_stream_manifest
target_limit = b'_STREAM_MANIFEST_LIMIT = RateLimiter(900, 60.0, name="stream_manifest")'
replacement_limit = target_limit + nl + b'_STREAM_LOCKS: dict[str, asyncio.Lock] = {}'

if target_limit in text and b'_STREAM_LOCKS:' not in text:
    text = text.replace(target_limit, replacement_limit, 1)
    print("Defined _STREAM_LOCKS!")

# 2. Add single-flight lock around m3u8 fetch in rave_stream_manifest
target_cache_check = nl.join([
    b'    now_m = time.time()',
    b'    cached_m = _M3U8_CACHE.get(m3u8_ckey)',
    b'    ttl_m = 2.0 if is_live_tv else 240.0',
    b'    if cached_m and now_m - cached_m[0] < ttl_m:',
    b'        c_bytes = cached_m[1] if isinstance(cached_m[1], bytes) else str(cached_m[1]).encode("utf-8")',
    b'        return Response(b"" if request.method == "HEAD" else c_bytes, media_type="application/vnd.apple.mpegurl", headers={',
    b'            "Access-Control-Allow-Origin": "*",',
    b'            "Content-Length": str(len(c_bytes)),',
    b'            "Cache-Control": "no-cache, no-store" if is_live_tv else "public, max-age=300",',
    b'        })',
    b'    try:',
])

replacement_cache_check = nl.join([
    b'    now_m = time.time()',
    b'    cached_m = _M3U8_CACHE.get(m3u8_ckey)',
    b'    ttl_m = 2.0 if is_live_tv else 240.0',
    b'    if cached_m and now_m - cached_m[0] < ttl_m:',
    b'        c_bytes = cached_m[1] if isinstance(cached_m[1], bytes) else str(cached_m[1]).encode("utf-8")',
    b'        return Response(b"" if request.method == "HEAD" else c_bytes, media_type="application/vnd.apple.mpegurl", headers={',
    b'            "Access-Control-Allow-Origin": "*",',
    b'            "Content-Length": str(len(c_bytes)),',
    b'            "Cache-Control": "no-cache, no-store" if is_live_tv else "public, max-age=300",',
    b'        })',
    b'    if len(_STREAM_LOCKS) > 300:',
    b'        _STREAM_LOCKS.clear()',
    b'    _manifest_lock = _STREAM_LOCKS.setdefault(m3u8_ckey, asyncio.Lock())',
    b'    async with _manifest_lock:',
    b'        # Double-check cache inside single-flight lock',
    b'        now_m2 = time.time()',
    b'        cached_m2 = _M3U8_CACHE.get(m3u8_ckey)',
    b'        if cached_m2 and now_m2 - cached_m2[0] < ttl_m:',
    b'            c_bytes2 = cached_m2[1] if isinstance(cached_m2[1], bytes) else str(cached_m2[1]).encode("utf-8")',
    b'            return Response(b"" if request.method == "HEAD" else c_bytes2, media_type="application/vnd.apple.mpegurl", headers={',
    b'                "Access-Control-Allow-Origin": "*",',
    b'                "Content-Length": str(len(c_bytes2)),',
    b'                "Cache-Control": "no-cache, no-store" if is_live_tv else "public, max-age=300",',
    b'            })',
    b'        try:',
])

if target_cache_check in text:
    text = text.replace(target_cache_check, replacement_cache_check, 1)
    # Also indent the try block or adjust exception handling if needed?
    # Notice: inside async with _manifest_lock:, try: was at 4 spaces indentation, now it will be at 8 spaces indentation!
    print("Found target_cache_check, but check indentation of try block!")
else:
    print("target_cache_check not found directly, checking lines...")
