with open('c:/Users/pc/Documents/projelerim/rave_web_platform/static/js/players/subtitles.js', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if 'offset' in line.lower() or 'sync' in line.lower() or 'cue' in line.lower() or 'drift' in line.lower():
            if any(k in line for k in ['function', 'const', 'let', 'offset =', 'offset +', 'autoOffset', 'applyOffset']):
                print(f"{i+1}: {line.strip()[:100]}")
