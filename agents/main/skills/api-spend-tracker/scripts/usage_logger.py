#!/usr/bin/env python3
"""
Local usage logger. Import and call log_usage() after every LLM API call.
This is the primary source of truth — provider usage APIs lag by hours.

Usage:
    from scripts.usage_logger import log_usage
    log_usage(
        provider="anthropic",
        api_key_label="main",
        model="claude-sonnet-4-20250514",
        input_tokens=1200,
        output_tokens=350,
    )
"""

import json
import os
import sys
import sqlite3
from datetime import datetime, timezone

# Add parent scripts dir to path so cost_tables can be found
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cost_tables import calculate_cost

DB_PATH = os.environ.get("SPEND_TRACKER_DB", os.path.expanduser("~/.openclaw/api_usage.db"))

_schema_ensured: set[str] = set()


def _ensure_schema(conn: sqlite3.Connection, db_path: str):
    if db_path in _schema_ensured:
        return
    c = conn.cursor()
    c.execute(
        """
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
        """
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp)"
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_provider_key ON usage_log(provider, api_key_label)"
    )
    _schema_ensured.add(db_path)


def _as_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def log_usage(
    provider: str,
    api_key_label: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    metadata: dict | None = None,
    db_path: str = DB_PATH,
):
    """Log a single API call to SQLite. Returns cost in USD."""
    input_tokens = max(0, _as_int(input_tokens))
    output_tokens = max(0, _as_int(output_tokens))
    cache_read_tokens = max(0, _as_int(cache_read_tokens))
    cache_write_tokens = max(0, _as_int(cache_write_tokens))
    cost = calculate_cost(
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_write_tokens=cache_write_tokens,
    )

    conn = sqlite3.connect(db_path)
    _ensure_schema(conn, db_path)
    c = conn.cursor()
    c.execute(
        """
        INSERT INTO usage_log
            (timestamp, provider, api_key_label, model,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             cost_usd, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            provider,
            api_key_label,
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            cost,
            json.dumps(metadata) if metadata else None,
        ),
    )
    conn.commit()
    conn.close()
    return cost


# ─── Convenience wrappers per provider ────────────────────────────────

def log_anthropic(response, api_key_label: str = "default"):
    """Log from an Anthropic SDK response object."""
    usage = response.usage
    return log_usage(
        provider="anthropic",
        api_key_label=api_key_label,
        model=response.model,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        cache_write_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
    )


def log_openai(response, api_key_label: str = "default"):
    """Log from an OpenAI SDK response object."""
    usage = response.usage
    cached = 0
    details = None
    if hasattr(usage, "prompt_tokens_details") and usage.prompt_tokens_details:
        details = usage.prompt_tokens_details
    elif hasattr(usage, "input_tokens_details") and usage.input_tokens_details:
        details = usage.input_tokens_details
    if details is not None:
        cached = getattr(details, "cached_tokens", 0) or 0

    input_tokens = getattr(usage, "prompt_tokens", None)
    output_tokens = getattr(usage, "completion_tokens", None)
    if input_tokens is None:
        input_tokens = getattr(usage, "input_tokens", 0) or 0
    if output_tokens is None:
        output_tokens = getattr(usage, "output_tokens", 0) or 0

    model = getattr(response, "model", None) or getattr(response, "model_id", "unknown")
    return log_usage(
        provider="openai",
        api_key_label=api_key_label,
        model=model,
        input_tokens=max(0, _as_int(input_tokens) - _as_int(cached)),
        output_tokens=_as_int(output_tokens),
        cache_read_tokens=_as_int(cached),
    )


def log_google(response, api_key_label: str = "default", model: str = "gemini-2.5-flash"):
    """Log from a Google Generative AI SDK response object."""
    meta = response.usage_metadata
    prompt_tokens = getattr(meta, "prompt_token_count", 0) or 0
    output_tokens = getattr(meta, "candidates_token_count", 0) or 0
    cached_tokens = getattr(meta, "cached_content_token_count", 0) or 0
    return log_usage(
        provider="google",
        api_key_label=api_key_label,
        model=model,
        input_tokens=max(0, _as_int(prompt_tokens) - _as_int(cached_tokens)),
        output_tokens=_as_int(output_tokens),
        cache_read_tokens=_as_int(cached_tokens),
    )
