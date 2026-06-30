#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HERMES_SECRET_KEY", "scan-only")
os.environ.setdefault("HERMES_PASSWORD_HASH", "scan-only")
os.environ.setdefault("HERMES_INGEST_TOKEN", "scan-only")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import init_db, scan_cron_outputs


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan Hermes cron Markdown outputs into tracked metrics.")
    parser.add_argument("--limit-per-source", type=int, default=0, help="0 means scan every matching file.")
    parser.add_argument("--rescan", action="store_true", help="Reprocess files even if a rule already scanned them.")
    parser.add_argument("--sync", action="store_true", help="Replace stored points for scanned cron sources with current files.")
    parser.add_argument("--source-id", default="", help="Only scan one cron source id.")
    args = parser.parse_args()

    init_db()
    result = scan_cron_outputs(
        limit_per_source=args.limit_per_source,
        rescan=args.rescan,
        sync=args.sync,
        source_id=args.source_id,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
