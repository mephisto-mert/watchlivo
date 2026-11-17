import inspect
import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import rooms

print("create_room code:")
lines = inspect.getsource(rooms.create_room).splitlines()[:50]
for l in lines:
    print(l)
