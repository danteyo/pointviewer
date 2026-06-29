#!/usr/bin/env python3
from __future__ import annotations

import math
import os
import random
import time
from pathlib import Path

os.environ.setdefault("HERMES_SECRET_KEY", "dev-secret")
os.environ.setdefault("HERMES_PASSWORD_HASH", "dev-password-hash")
os.environ.setdefault("HERMES_INGEST_TOKEN", "dev-token")

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import init_db, upsert_point


random.seed(7)
init_db()
now = int(time.time())
series = [
    ("gold_spot", "黄金现货", "USD/oz", "market", 1, 2320, 36),
    ("spy", "S&P 500 ETF", "USD", "market", 2, 547, 8),
    ("front_door_motion", "门口触发次数", "次", "home", 10, 6, 4),
    ("living_room_temp", "客厅温度", "°C", "home", 11, 25.5, 1.8),
]

for key, name, unit, category, order, base, swing in series:
    for index in range(7 * 24):
        recorded_at = now - (7 * 24 - index) * 3600
        wave = math.sin(index / 9) * swing
        noise = random.uniform(-swing * 0.18, swing * 0.18)
        value = max(0, base + wave + noise)
        if key == "front_door_motion":
            value = round(value)
        upsert_point(
            {
                "key": key,
                "name": name,
                "unit": unit,
                "category": category,
                "sort_order": order,
                "value": value,
                "recorded_at": recorded_at,
            }
        )

print("Seeded demo data.")
