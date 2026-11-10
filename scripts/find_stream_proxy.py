with open('c:/Users/pc/Documents/projelerim/rave_web_platform/server.py', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if 'def stream_proxy' in line or 'Route("/api/rave/stream"' in line:
            print(f"{i+1}: {line.strip()[:100]}")
