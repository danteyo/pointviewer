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
import re
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
DEFAULT_CRON_BASE = "~/.hermes/cron/output"


DEFAULT_CRON_SOURCES = [
    {
        "id": "241db7b2b9e7",
        "name": "每日热点摘要",
        "output_dir": f"{DEFAULT_CRON_BASE}/241db7b2b9e7",
        "file_glob": "*.md",
        "schedule": "17:30 每日",
        "enabled": 1,
    },
    {
        "id": "ced3e233f5d9",
        "name": "体坛简报",
        "output_dir": f"{DEFAULT_CRON_BASE}/ced3e233f5d9",
        "file_glob": "*.md",
        "schedule": "09:00 隔天",
        "enabled": 1,
    },
    {
        "id": "e6a852568717",
        "name": "财经简报",
        "output_dir": f"{DEFAULT_CRON_BASE}/e6a852568717",
        "file_glob": "*.md",
        "schedule": "11:30 工作日",
        "enabled": 1,
    },
    {
        "id": "81fb82f53914",
        "name": "HA日报",
        "output_dir": f"{DEFAULT_CRON_BASE}/81fb82f53914",
        "file_glob": "*.md",
        "schedule": "18:30 每日",
        "enabled": 1,
    },
]


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

            CREATE TABLE IF NOT EXISTS cron_sources (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                output_dir TEXT NOT NULL,
                file_glob TEXT NOT NULL DEFAULT '*.md',
                schedule TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cron_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL REFERENCES cron_sources(id) ON DELETE CASCADE,
                metric_key TEXT NOT NULL,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT 'cron',
                sort_order INTEGER NOT NULL DEFAULT 100,
                pattern TEXT NOT NULL,
                group_index INTEGER NOT NULL DEFAULT 1,
                value_scale REAL NOT NULL DEFAULT 1,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cron_rule_runs (
                rule_id INTEGER NOT NULL REFERENCES cron_rules(id) ON DELETE CASCADE,
                file_path TEXT NOT NULL,
                file_mtime INTEGER NOT NULL,
                recorded_at INTEGER NOT NULL,
                PRIMARY KEY (rule_id, file_path, file_mtime)
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            """
        )
        count = conn.execute("SELECT COUNT(*) FROM cron_sources").fetchone()[0]
        if count == 0:
            for source in DEFAULT_CRON_SOURCES:
                conn.execute(
                    """
                    INSERT INTO cron_sources(id, name, output_dir, file_glob, schedule, enabled, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        source["id"],
                        source["name"],
                        source["output_dir"],
                        source["file_glob"],
                        source["schedule"],
                        source["enabled"],
                        now(),
                    ),
                )


def get_setting(key: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else None


def set_setting(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO app_settings(key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (key, value, now()),
        )


def get_password_hash() -> str:
    return get_setting("password_hash") or env_required("HERMES_PASSWORD_HASH")


def change_password(current_password: str, new_password: str) -> None:
    if len(new_password) < 8:
        raise ValueError("new password must be at least 8 characters")
    if not verify_password(current_password, get_password_hash()):
        raise PermissionError("current password incorrect")
    set_setting("password_hash", hash_password(new_password))


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


def list_cron_config() -> dict[str, object]:
    with connect() as conn:
        source_rows = conn.execute(
            """
            SELECT * FROM cron_sources
            ORDER BY enabled DESC, name
            """
        ).fetchall()
        rule_rows = conn.execute(
            """
            SELECT * FROM cron_rules
            ORDER BY source_id, enabled DESC, sort_order, name
            """
        ).fetchall()
    sources = [dict(row) for row in source_rows]
    rules_by_source: dict[str, list[dict[str, object]]] = {}
    for row in rule_rows:
        rule = dict(row)
        rules_by_source.setdefault(str(rule["source_id"]), []).append(rule)
    for source in sources:
        source["rules"] = rules_by_source.get(str(source["id"]), [])
    return {"sources": sources}


def clean_source_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", value.strip()).strip("_")
    return cleaned or secrets.token_hex(6)


def save_cron_source(data: dict[str, object]) -> dict[str, object]:
    source_id = clean_source_id(str(data.get("id") or data.get("name") or "source"))
    name = str(data.get("name") or source_id).strip()
    output_dir = str(data.get("output_dir") or "").strip()
    file_glob = str(data.get("file_glob") or "*.md").strip()
    schedule = str(data.get("schedule") or "").strip()
    enabled = 1 if data.get("enabled", True) else 0
    rules = data.get("rules") or []
    if not output_dir:
        raise ValueError("output_dir is required")
    if not isinstance(rules, list):
        raise ValueError("rules must be a list")

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO cron_sources(id, name, output_dir, file_glob, schedule, enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                output_dir = excluded.output_dir,
                file_glob = excluded.file_glob,
                schedule = excluded.schedule,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            """,
            (source_id, name, output_dir, file_glob, schedule, enabled, now()),
        )
        conn.execute("DELETE FROM cron_rules WHERE source_id = ?", (source_id,))
        for index, rule in enumerate(rules):
            if not isinstance(rule, dict):
                continue
            pattern = str(rule.get("pattern") or "").strip()
            metric_key = str(rule.get("metric_key") or "").strip()
            if not pattern or not metric_key:
                continue
            conn.execute(
                """
                INSERT INTO cron_rules(
                    source_id, metric_key, name, unit, category, sort_order, pattern,
                    group_index, value_scale, enabled, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_id,
                    metric_key,
                    str(rule.get("name") or metric_key).strip(),
                    str(rule.get("unit") or "").strip(),
                    str(rule.get("category") or "cron").strip(),
                    int(rule.get("sort_order") or (100 + index)),
                    pattern,
                    int(rule.get("group_index") or 1),
                    float(rule.get("value_scale") or 1),
                    1 if rule.get("enabled", True) else 0,
                    now(),
                ),
            )
    return {"ok": True, "id": source_id}


def delete_cron_source(source_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM cron_sources WHERE id = ?", (source_id,))


def parse_number(value: str) -> float:
    cleaned = value.strip().replace(",", "")
    match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    if not match:
        raise ValueError(f"cannot parse number from {value!r}")
    return float(match.group(0))


def scan_cron_outputs(limit_per_source: int = 5, rescan: bool = False) -> dict[str, object]:
    summary: dict[str, object] = {"sources": 0, "files": 0, "points": 0, "errors": []}
    with connect() as conn:
        sources = conn.execute("SELECT * FROM cron_sources WHERE enabled = 1 ORDER BY name").fetchall()
        rules = conn.execute("SELECT * FROM cron_rules WHERE enabled = 1 ORDER BY sort_order, name").fetchall()
        rules_by_source: dict[str, list[sqlite3.Row]] = {}
        for rule in rules:
            rules_by_source.setdefault(str(rule["source_id"]), []).append(rule)

    for source in sources:
        source_rules = rules_by_source.get(str(source["id"]), [])
        if not source_rules:
            continue
        summary["sources"] = int(summary["sources"]) + 1
        output_dir = Path(str(source["output_dir"])).expanduser()
        files = sorted(output_dir.glob(str(source["file_glob"])), key=lambda item: item.stat().st_mtime, reverse=True)
        for path in files[:limit_per_source]:
            try:
                content = path.read_text(encoding="utf-8")
                file_mtime = int(path.stat().st_mtime)
                recorded_at = file_mtime
                summary["files"] = int(summary["files"]) + 1
                for rule in source_rules:
                    run_exists = False
                    if not rescan:
                        with connect() as conn:
                            run_exists = bool(
                                conn.execute(
                                    """
                                    SELECT 1 FROM cron_rule_runs
                                    WHERE rule_id = ? AND file_path = ? AND file_mtime = ?
                                    """,
                                    (rule["id"], str(path), file_mtime),
                                ).fetchone()
                            )
                    if run_exists:
                        continue
                    pattern = re.compile(str(rule["pattern"]), re.MULTILINE | re.IGNORECASE)
                    match = pattern.search(content)
                    if not match:
                        continue
                    value = parse_number(match.group(int(rule["group_index"]))) * float(rule["value_scale"])
                    upsert_point(
                        {
                            "key": rule["metric_key"],
                            "name": rule["name"],
                            "unit": rule["unit"],
                            "category": rule["category"],
                            "sort_order": rule["sort_order"],
                            "value": value,
                            "recorded_at": recorded_at,
                            "note": f"{source['name']}: {path.name}",
                        }
                    )
                    with connect() as conn:
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO cron_rule_runs(rule_id, file_path, file_mtime, recorded_at)
                            VALUES (?, ?, ?, ?)
                            """,
                            (rule["id"], str(path), file_mtime, recorded_at),
                        )
                    summary["points"] = int(summary["points"]) + 1
            except Exception as exc:
                summary["errors"].append({"file": str(path), "error": str(exc)})
    return summary


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
        if parsed.path == "/api/cron-config":
            if self.require_session():
                self.send_json(HTTPStatus.OK, list_cron_config())
            return
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/login":
                data = self.read_json()
                password = str(data.get("password", "")) if isinstance(data, dict) else ""
                if verify_password(password, get_password_hash()):
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
            if parsed.path == "/api/change-password":
                if not self.require_session():
                    return
                data = self.read_json()
                if not isinstance(data, dict):
                    raise ValueError("password payload must be an object")
                change_password(str(data.get("current_password") or ""), str(data.get("new_password") or ""))
                self.send_json(HTTPStatus.OK, {"ok": True})
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
            if parsed.path == "/api/cron-sources":
                if not self.require_session():
                    return
                data = self.read_json()
                if not isinstance(data, dict):
                    raise ValueError("source payload must be an object")
                self.send_json(HTTPStatus.OK, save_cron_source(data))
                return
            if parsed.path == "/api/cron-sources/delete":
                if not self.require_session():
                    return
                data = self.read_json()
                if not isinstance(data, dict):
                    raise ValueError("delete payload must be an object")
                delete_cron_source(str(data.get("id") or ""))
                self.send_json(HTTPStatus.OK, {"ok": True})
                return
            if parsed.path == "/api/cron-scan":
                if not self.require_session():
                    return
                data = self.read_json()
                options = data if isinstance(data, dict) else {}
                result = scan_cron_outputs(
                    limit_per_source=int(options.get("limit_per_source") or 5),
                    rescan=bool(options.get("rescan") or False),
                )
                self.send_json(HTTPStatus.OK, result)
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        except PermissionError as exc:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": str(exc)})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})


def main() -> None:
    init_db()
    httpd = ThreadingHTTPServer((HOST, PORT), HermesHandler)
    print(f"Hermes dashboard listening on http://{HOST}:{PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
