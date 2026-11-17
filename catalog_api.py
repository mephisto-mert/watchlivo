"""Dedicated serverless entrypoint for slow external search/catalog scraping so room sync never blocks."""
import os
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
os.environ["SYNC_SECRET"] = "dev-mode-secret-key-12345"
os.environ["AUTH_SECRET"] = "dev-mode-auth-secret-12345"
os.environ["PROXY_SECRET"] = "dev-mode-proxy-secret-12345"
from server import app  # noqa: F401
