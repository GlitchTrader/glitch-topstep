"""Transactional local projection of the gateway's revisioned outcome feed."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable


class OutcomeStore:
    def __init__(self, state: Path) -> None:
        state.mkdir(parents=True, exist_ok=True)
        self.path = state / "outcomes.sqlite"
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS outcome_revisions (
                sequence INTEGER PRIMARY KEY,
                outcome_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                status TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                recorded_utc TEXT,
                UNIQUE(outcome_id, revision)
            );
            CREATE TABLE IF NOT EXISTS outcomes_current (
                outcome_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                sequence INTEGER NOT NULL,
                status TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_utc TEXT
            );
            CREATE TABLE IF NOT EXISTS feed_cursor (
                name TEXT PRIMARY KEY,
                sequence INTEGER NOT NULL,
                updated_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS outcome_revisions_sequence_idx
                ON outcome_revisions(sequence);
            """
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def bootstrap_jsonl(self, path: Path) -> None:
        """Import an existing projection once, without trusting it as the cursor."""
        count = self.db.execute("SELECT COUNT(*) FROM outcomes_current").fetchone()[0]
        if count or not path.is_file():
            return
        sequence = 0
        with self.db:
            for raw in path.read_text(encoding="utf-8").splitlines():
                if not raw.strip():
                    continue
                row = json.loads(raw)
                if not isinstance(row, dict) or not row.get("outcome_id"):
                    continue
                sequence += 1
                payload = json.dumps(row, sort_keys=True, separators=(",", ":"))
                content_hash = str(row.get("_feed_content_hash") or hashlib.sha256(payload.encode()).hexdigest())
                self._insert_revision(sequence, row, 1, "bootstrap", content_hash, row.get("exit_utc"))
                self.db.execute(
                    "INSERT INTO outcomes_current VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (str(row["outcome_id"]), 1, sequence, "bootstrap", content_hash, payload, row.get("exit_utc")),
                )
            self._set_cursor(sequence)

    def apply(self, revisions: Iterable[dict[str, Any]], high_water: int | None, updated_utc: str) -> dict[str, int]:
        added = revised = applied = 0
        with self.db:
            for revision in revisions:
                row = revision.get("outcome")
                sequence = revision.get("sequence")
                if not isinstance(row, dict) or not row.get("outcome_id") or not isinstance(sequence, int):
                    continue
                outcome_id = str(row["outcome_id"])
                revision_number = int(revision.get("revision") or 1)
                status = str(revision.get("status") or "enriched")
                payload = json.dumps(row, sort_keys=True, separators=(",", ":"))
                content_hash = str(revision.get("content_hash") or hashlib.sha256(payload.encode()).hexdigest())
                existing = self.db.execute(
                    "SELECT content_hash FROM outcome_revisions WHERE sequence = ?", (sequence,)
                ).fetchone()
                if existing:
                    if existing[0] != content_hash:
                        raise ValueError(f"outcome_sequence_conflict:{sequence}")
                    continue
                prior = self.db.execute(
                    "SELECT revision FROM outcomes_current WHERE outcome_id = ?", (outcome_id,)
                ).fetchone()
                self._insert_revision(sequence, row, revision_number, status, content_hash, revision.get("recorded_utc"))
                self.db.execute(
                    """
                    INSERT INTO outcomes_current
                    (outcome_id, revision, sequence, status, content_hash, payload_json, updated_utc)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(outcome_id) DO UPDATE SET
                      revision=excluded.revision, sequence=excluded.sequence, status=excluded.status,
                      content_hash=excluded.content_hash, payload_json=excluded.payload_json,
                      updated_utc=excluded.updated_utc
                    WHERE excluded.revision >= outcomes_current.revision
                    """,
                    (outcome_id, revision_number, sequence, status, content_hash, payload, updated_utc),
                )
                applied += 1
                if prior is None:
                    added += 1
                else:
                    revised += 1
            cursor = max(int(high_water or 0), self.cursor())
            self._set_cursor(cursor, updated_utc)
        return {"added": added, "revised": revised, "applied": applied, "sequence": cursor}

    def cursor(self) -> int:
        row = self.db.execute("SELECT sequence FROM feed_cursor WHERE name = 'gateway_outcomes'").fetchone()
        return int(row[0]) if row else 0

    def current(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT payload_json FROM outcomes_current ORDER BY sequence").fetchall()
        return [json.loads(row[0]) for row in rows]

    def export_jsonl(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        body = "".join(f"{json.dumps(row, separators=(',', ':'))}\n" for row in self.current())
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(body, encoding="utf-8")
        temporary.replace(path)

    def status(self) -> dict[str, Any]:
        integrity = self.db.execute("PRAGMA integrity_check").fetchone()[0]
        return {
            "path": str(self.path),
            "current_count": self.db.execute("SELECT COUNT(*) FROM outcomes_current").fetchone()[0],
            "revision_count": self.db.execute("SELECT COUNT(*) FROM outcome_revisions").fetchone()[0],
            "sequence": self.cursor(),
            "integrity": integrity,
        }

    def _insert_revision(self, sequence: int, row: dict[str, Any], revision: int, status: str, content_hash: str, recorded_utc: Any) -> None:
        payload = json.dumps(row, sort_keys=True, separators=(",", ":"))
        self.db.execute(
            "INSERT INTO outcome_revisions VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sequence, str(row["outcome_id"]), revision, status, content_hash, payload, recorded_utc),
        )

    def _set_cursor(self, sequence: int, updated_utc: str | None = None) -> None:
        self.db.execute(
            "INSERT INTO feed_cursor(name, sequence, updated_utc) VALUES ('gateway_outcomes', ?, ?) "
            "ON CONFLICT(name) DO UPDATE SET sequence=excluded.sequence, updated_utc=excluded.updated_utc",
            (sequence, updated_utc or "bootstrap"),
        )
