import inspect
import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import rooms

lines = inspect.getsource(rooms.http_sync).splitlines()[60:130]
for l in lines:
    if "seek" in l or "play" in l or "media" in l:
        print(l)
