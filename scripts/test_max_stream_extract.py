# -*- coding: utf-8 -*-
import sys
import io
import os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.abspath("."))

from server import _extract_direct_stream_sync

res = _extract_direct_stream_sync("1038392", "movie", 1, 1, "The Conjuring: Last Rites", "2025", "", "Korku Seansı 4: Son Ayin", "", False)
print("Extracted streams for Korku Seansi 4:", len(res or []))
for r in (res or []):
    print("  - Stream:", r[1], str(r[0])[:80])
