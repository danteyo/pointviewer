#!/usr/bin/env python3
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import hash_password


password = getpass.getpass("Password: ")
confirm = getpass.getpass("Confirm: ")
if password != confirm:
    raise SystemExit("passwords do not match")
print(hash_password(password))
