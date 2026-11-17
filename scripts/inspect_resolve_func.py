import inspect
import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

print("resolve_catalog doc/params:")
lines = inspect.getsource(server.resolve_catalog).splitlines()[:60]
for l in lines:
    print(l)
