with open('c:/Users/pc/Documents/projelerim/rave_web_platform/server.py', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if 'def rave_stream_manifest' in line:
            print(f"{i+1}: {line.strip()[:100]}")
