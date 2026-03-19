#!/usr/bin/env python3
"""Initialize the SQLite database for API usage tracking."""

import os
import sqlite3

DB_PATH = os.environ.get("SPEND_TRACKER_DB", os.path.expanduser("~/.openclaw/api_usage.db"))


def init_db(db_path: str = DB_PATH):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS usage_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            provider TEXT NOT NULL,
            api_key_label TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cache_read_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0.0,
            metadata TEXT
        )
    """)

    c.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp)
    """)

    c.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_provider_key ON usage_log(provider, api_key_label)
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS daily_summary (
            date TEXT NOT NULL,
            provider TEXT NOT NULL,
            api_key_label TEXT NOT NULL,
            model TEXT NOT NULL,
            total_input_tokens INTEGER DEFAULT 0,
            total_output_tokens INTEGER DEFAULT 0,
            total_cache_read_tokens INTEGER DEFAULT 0,
            total_cache_write_tokens INTEGER DEFAULT 0,
            total_cost_usd REAL DEFAULT 0.0,
            call_count INTEGER DEFAULT 0,
            PRIMARY KEY (date, provider, api_key_label, model)
        )
    """)

    conn.commit()
    conn.close()
    print(f"Database initialized at {db_path}")


if __name__ == "__main__":
    init_db()
