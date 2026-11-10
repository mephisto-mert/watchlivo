with open("server.py", "r", encoding="utf-8") as f:
    for i, line in enumerate(f):
        if "tmdb" in line.lower() and ("key" in line.lower() or "api" in line.lower() or "search" in line.lower() or "endpoint" in line.lower()):
            print(f"{i+1}: {line.strip()[:100]}")
