#!/usr/bin/env python3
"""Hermes metrics dashboard.

Small dependency-free web app for showing scheduled metrics and Home Assistant
signals with login protection and SQLite-backed history.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("HERMES_DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.environ.get("HERMES_DB_PATH", DATA_DIR / "hermes.db"))
HOST = os.environ.get("HERMES_HOST", "127.0.0.1")
PORT = int(os.environ.get("HERMES_PORT", "8080"))
SESSION_COOKIE = "hermes_session"


def env_required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def now() -> int:
    return int(time.time())


def json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def sign(value: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).digest()
    return b64url(digest)


def make_session(secret: str) -> str:
    payload = {"iat": now(), "nonce": secrets.token_urlsafe(18)}
    encoded = b64url(json_bytes(payload))
    return f"{encoded}.{sign(encoded, secret)}"


def verify_session(cookie_value: str, secret: str, max_age_seconds: int = 86400) -> bool:
    try:
        encoded, signature = cookie_value.split(".", 1)
        expected = sign(encoded, secret)
        if not hmac.compare_digest(signature, expected):
            return False
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
        return now() - int(payload.get("iat", 0)) <= max_age_seconds
    except Exception:
        return False


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 260_000)
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        method, salt, expected = stored_hash.split("$", 2)
        if method != "pbkdf2_sha256":
            return False
        candidate = hash_password(password, salt).split("$", 2)[2]
        return hmac.compare_digest(candidate, expected)
    except ValueError:
        return False


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS metrics (
                key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'general',
                sort_order INTEGER NOT NULL DEFAULT 100,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS metric_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                metric_key TEXT NOT NULL REFERENCES metrics(key) ON DELETE CASCADE,
                value REAL NOT NULL,
                recorded_at INTEGER NOT NULL,
                note TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_metric_points_lookup
                ON metric_points(metric_key, recorded_at);
            """
        )


def latest_metrics() -> list[dict[str, object]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT m.key, m.name, m.unit, m.category, m.updated_at,
                   p.value, p.recorded_at
            FROM metrics m
            LEFT JOIN metric_points p ON p.id = (
                SELECT id FROM metric_points
                WHERE metric_key = m.key
                ORDER BY recorded_at DESC, id DESC
                LIMIT 1
            )
            ORDER BY m.sort_order, m.category, m.name
            """
        ).fetchall()
    return [dict(row) for row in rows]


def history(metric_key: str, start: int, end: int) -> dict[str, object] | None:
    with connect() as conn:
        metric = conn.execute("SELECT * FROM metrics WHERE key = ?", (metric_key,)).fetchone()
        if not metric:
            return None
        rows = conn.execute(
            """
            SELECT value, recorded_at, note
            FROM metric_points
            WHERE metric_key = ? AND recorded_at BETWEEN ? AND ?
            ORDER BY recorded_at
            """,
            (metric_key, start, end),
        ).fetchall()
    return {"metric": dict(metric), "points": [dict(row) for row in rows]}


def upsert_point(item: dict[str, object]) -> None:
    metric_key = str(item["key"]).strip()
    name = str(item.get("name") or metric_key).strip()
    unit = str(item.get("unit") or "").strip()
    category = str(item.get("category") or "general").strip()
    sort_order = int(item.get("sort_order") or 100)
    value = float(item["value"])
    recorded_at = int(item.get("recorded_at") or now())
    note = str(item.get("note") or "")

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO metrics(key, name, unit, category, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                name = excluded.name,
                unit = excluded.unit,
                category = excluded.category,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at
            """,
            (metric_key, name, unit, category, sort_order, recorded_at),
        )
        conn.execute(
            """
            INSERT INTO metric_points(metric_key, value, recorded_at, note)
            VALUES (?, ?, ?, ?)
            """,
            (metric_key, value, recorded_at, note),
        )


class HermesHandler(SimpleHTTPRequestHandler):
    server_version = "HermesDashboard/1.0"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        if parsed.path == "/":
            return str(STATIC_DIR / "index.html")
        return str(STATIC_DIR / parsed.path.lstrip("/"))

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: HTTPStatus, payload: object) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, object] | list[dict[str, object]]:
        size = int(self.headers.get("Content-Length", "0"))
        if size > 1_000_000:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def session_ok(self) -> bool:
        cookie = SimpleCookie(self.headers.get("Cookie"))
        morsel = cookie.get(SESSION_COOKIE)
        return bool(morsel and verify_session(morsel.value, env_required("HERMES_SECRET_KEY")))

    def require_session(self) -> bool:
        if self.session_ok():
            return True
        self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        return False

    def require_ingest_token(self) -> bool:
        configured = env_required("HERMES_INGEST_TOKEN")
        provided = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if hmac.compare_digest(configured, provided):
            return True
        self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "bad ingest token"})
        return False

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/session":
            self.send_json(HTTPStatus.OK, {"authenticated": self.session_ok()})
            return
        if parsed.path == "/api/metrics":
            if self.require_session():
                self.send_json(HTTPStatus.OK, {"metrics": latest_metrics()})
            return
        if parsed.path == "/api/history":
            if not self.require_session():
                return
            query = parse_qs(parsed.query)
            metric_key = (query.get("key") or [""])[0]
            end = int((query.get("end") or [str(now())])[0])
            start = int((query.get("start") or [str(end - 7 * 86400)])[0])
            result = history(metric_key, start, end)
            if result is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "metric not found"})
            else:
                self.send_json(HTTPStatus.OK, result)
            return
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/login":
                data = self.read_json()
                password = str(data.get("password", "")) if isinstance(data, dict) else ""
                if verify_password(password, env_required("HERMES_PASSWORD_HASH")):
                    token = make_session(env_required("HERMES_SECRET_KEY"))
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header(
                        "Set-Cookie",
                        f"{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400",
                    )
                    self.end_headers()
                    self.wfile.write(json_bytes({"ok": True}))
                else:
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "password incorrect"})
                return
            if parsed.path == "/api/logout":
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header(
                    "Set-Cookie",
                    f"{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
                )
                self.end_headers()
                self.wfile.write(json_bytes({"ok": True}))
                return
            if parsed.path == "/api/ingest":
                if not self.require_ingest_token():
                    return
                data = self.read_json()
                items = data if isinstance(data, list) else [data]
                for item in items:
                    upsert_point(item)
                self.send_json(HTTPStatus.CREATED, {"ok": True, "count": len(items)})
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})


def main() -> None:
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), HermesHandler)
    print(f"Hermes dashboard listening on http://{HOST}:{PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
