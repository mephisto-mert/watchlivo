"""Pytest isolation harness — prevents tests from mutating live local rave_platform.db."""
from __future__ import annotations

import atexit
import os
import pathlib
import sqlite3
import tempfile

import pytest

_SESSION_TMP = tempfile.TemporaryDirectory(prefix="watchlivo_pytest_")
atexit.register(_SESSION_TMP.cleanup)
_ISOLATED_DB = pathlib.Path(_SESSION_TMP.name) / "pytest_rave_platform.db"
os.environ["WATCHLIVO_DB_PATH"] = str(_ISOLATED_DB)
# rooms.MemoryStore persists rooms under tempfile.gettempdir()/vortex_rooms; point
# it at the per-session dir so rooms from earlier runs never leak into the lobby
# (e.g. pushing freshly created rooms past the 60-entry lobby cap).
tempfile.tempdir = _SESSION_TMP.name

_ORIG_SQLITE_CONNECT = sqlite3.connect


def _guarded_sqlite_connect(database, *args, **kwargs):
    db_str = str(database)
    if "rave_platform.db" in db_str and str(_SESSION_TMP.name) not in db_str:
        database = str(_ISOLATED_DB)
    return _ORIG_SQLITE_CONNECT(database, *args, **kwargs)


sqlite3.connect = _guarded_sqlite_connect


@pytest.fixture(scope="session", autouse=True)
def _isolate_watchlivo_sqlite_dbs():
    import auth_engine
    import server

    orig_auth_db = auth_engine.AUTH_DB_PATH
    orig_acc_db = getattr(server, "ACC_DB_PATH", None)

    auth_engine.AUTH_DB_PATH = _ISOLATED_DB
    auth_engine._AUTH_DB_SCHEMA_READY = False
    if hasattr(server, "ACC_DB_PATH"):
        server.ACC_DB_PATH = _ISOLATED_DB
        server._ACC_DB_SCHEMA_READY = False

    yield

    auth_engine.AUTH_DB_PATH = orig_auth_db
    auth_engine._AUTH_DB_SCHEMA_READY = False
    if orig_acc_db is not None and hasattr(server, "ACC_DB_PATH"):
        server.ACC_DB_PATH = orig_acc_db
        server._ACC_DB_SCHEMA_READY = False
