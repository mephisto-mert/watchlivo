with open('c:/Users/pc/Documents/projelerim/rave_web_platform/server.py', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if 'subtitleTracks' in line or 'subtitles' in line:
            if any(k in line for k in ['subtitles =', 'subtitleTracks =', 'subtitles.append', 'subtitleTracks.append', 'sub_list']):
                print(f"{i+1}: {line.strip()[:100]}")
