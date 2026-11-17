import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

FILE_PATH = "static/js/views/selection-kinds.js"
with open(FILE_PATH, "r", encoding="utf-8") as f:
    content = f.read()

target = """  container.append(
    topBar,
    heroBillboard,"""

replacement = """  container.append(
    topBar,
    ravePortalWindow,
    heroBillboard,"""

if target in content:
    content = content.replace(target, replacement, 1)
    print("Added ravePortalWindow to container.append")
else:
    print("target not found")

with open(FILE_PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("Updated selection-kinds.js successfully!")
