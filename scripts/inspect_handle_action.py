import inspect
import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import rooms

lines = inspect.getsource(rooms.handle_action).splitlines()[:60]
for l in lines:
    print(l)
