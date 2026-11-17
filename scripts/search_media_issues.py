import os

queries = ['penguin', 'karun hazinesi', 'organize işler', 'dota', 'amerika yapımı']
for root, dirs, files in os.walk('.'):
    if '.git' in root or '__pycache__' in root:
        continue
    for f in files:
        if f.endswith(('.js', '.json', '.py', '.html')):
            p = os.path.join(root, f)
            try:
                with open(p, 'r', encoding='utf-8', errors='ignore') as fp:
                    content = fp.read().lower()
                for q in queries:
                    if q in content:
                        print(f'Match "{q}" in {p}')
            except Exception:
                pass
