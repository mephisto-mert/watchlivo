import inspect
import sys
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

print("rave_stream_manifest doc/params:")
lines = inspect.getsource(server.rave_stream_manifest).splitlines()[:50]
for l in lines:
    print(l)
