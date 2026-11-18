"""Dedicated serverless entrypoint for slow external search/catalog requests so room sync never blocks."""
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from server import app  # noqa: F401,E402
