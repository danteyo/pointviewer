#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("HERMES_SECRET_KEY", "clear-demo")
os.environ.setdefault("HERMES_PASSWORD_HASH", "clear-demo")
os.environ.setdefault("HERMES_INGEST_TOKEN", "clear-demo")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import connect, init_db


DEMO_KEYS = ("gold_spot", "spy", "front_door_motion", "living_room_temp")


def main() -> None:
    init_db()
    with connect() as conn:
        deleted = conn.execute(
            f"DELETE FROM metrics WHERE key IN ({','.join('?' for _ in DEMO_KEYS)})",
            DEMO_KEYS,
        ).rowcount
    print(f"Deleted {deleted} demo metrics.")


if __name__ == "__main__":
    main()
