import urllib.request, urllib.parse

titles = [
    ("Don't Look Up (2021)", "movie"),
    ("The Last of Us — 2. Sezon 1. Bölüm", "tv"),
    ("Stranger Things — 1. Sezon 1. Bölüm", "tv"),
    ("Solo Leveling — 2. Sezon 12. Bölüm", "tv")
]

for t, mt in titles:
    u = 'https://watchlivo.online/api/rave/poster?' + urllib.parse.urlencode({'t': t, 'mt': mt})
    req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as resp:
            print(t, '->', resp.geturl())
    except Exception as e:
        print(t, '-> ERROR:', e)
