import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
server_file = ROOT / "server.py"

content = server_file.read_text(encoding="utf-8")

for route in ['/api/rave/resolve-catalog', '/api/rave/stream', '/api/rave/catalog', '/api/rooms']:
    matches = [m.start() for m in re.finditer(re.escape(route), content)]
    print(f"Route '{route}' found {len(matches)} times")
    for idx in matches[:3]:
        line_no = content[:idx].count("\n") + 1
        print(f"  Line {line_no}: {content[idx-10:idx+60].strip()}")
