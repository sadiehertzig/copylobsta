#!/usr/bin/env python3
"""
Daily API Spend Reporter for OpenClaw.
Queries local SQLite for the last 24 hours, formats a Telegram digest, and sends it.

Cron target: runs daily at 8:00 AM ET.
Manual test: python3 reporter.py --test
"""

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

# Load .env if python-dotenv is available
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.expanduser("~/.openclaw/.env"))
except ImportError:
    pass

DB_PATH = os.environ.get("SPEND_TRACKER_DB", os.path.expanduser("~/.openclaw/api_usage.db"))
TELEGRAM_BOT_TOKEN = os.environ.get("OPENCLAW_TELEGRAM_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("OPENCLAW_TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")

PROVIDER_EMOJIS = {"anthropic": "\U0001f7e0", "openai": "\U0001f7e2", "google": "\U0001f535"}


def _query(db_path: str, sql: str, params: tuple) -> list[dict]:
    """Run a query and return rows as dicts."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    except sqlite3.OperationalError as e:
        if "no such table" in str(e).lower():
            return []
        raise
    finally:
        conn.close()


def query_local_usage(hours: int = 24, db_path: str = DB_PATH) -> list[dict]:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return _query(db_path, """
        SELECT provider, api_key_label, model,
               SUM(input_tokens) as total_input,
               SUM(output_tokens) as total_output,
               SUM(cache_read_tokens) as total_cache_read,
               SUM(cache_write_tokens) as total_cache_write,
               SUM(cost_usd) as total_cost,
               COUNT(*) as call_count
        FROM usage_log WHERE timestamp >= ?
        GROUP BY provider, api_key_label, model
        ORDER BY total_cost DESC
    """, (cutoff,))


def query_totals_by_key(hours: int = 24, db_path: str = DB_PATH) -> list[dict]:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return _query(db_path, """
        SELECT provider, api_key_label,
               SUM(cost_usd) as total_cost,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
               COUNT(*) as call_count
        FROM usage_log WHERE timestamp >= ?
        GROUP BY provider, api_key_label
        ORDER BY total_cost DESC
    """, (cutoff,))


def format_telegram_message(key_totals: list[dict], model_details: list[dict], hours: int = 24) -> str:
    """Build the Telegram message."""
    now_et = datetime.now(ZoneInfo("America/New_York"))
    date_str = now_et.strftime("%a %b %d, %Y")

    grand_total = sum(r["total_cost"] for r in key_totals)
    total_calls = sum(r["call_count"] for r in key_totals)
    total_tokens = sum(r["total_tokens"] for r in key_totals)

    lines = []
    lines.append(f"\U0001f4b0 OPENCLAW DAILY API SPEND")
    lines.append(f"\U0001f4c5 {date_str} (last {hours}h)")
    lines.append("\u2500" * 30)
    lines.append("")
    lines.append(f"TOTAL: ${grand_total:.4f}")
    lines.append(f"Calls: {total_calls:,}  |  Tokens: {total_tokens:,}")
    lines.append("")

    # Per-key breakdown
    lines.append("BY API KEY:")
    lines.append("\u2500" * 30)
    for row in key_totals:
        emoji = PROVIDER_EMOJIS.get(row["provider"], "\u26aa")
        pct = (row["total_cost"] / grand_total * 100) if grand_total > 0 else 0
        lines.append(f"{emoji} {row['api_key_label']} ({row['provider']})")
        lines.append(f"   ${row['total_cost']:.4f} ({pct:.1f}%) \u00b7 {row['call_count']} calls")

    lines.append("")

    # Model breakdown (top 10)
    lines.append("BY MODEL (top 10):")
    lines.append("\u2500" * 30)
    for row in model_details[:10]:
        emoji = PROVIDER_EMOJIS.get(row["provider"], "\u26aa")
        tokens = (
            row["total_input"]
            + row["total_output"]
            + row["total_cache_read"]
            + row["total_cache_write"]
        )
        lines.append(f"{emoji} {row['model']}")
        lines.append(f"   ${row['total_cost']:.4f} \u00b7 {tokens:,} tok \u00b7 {row['call_count']} calls")

    # Run rate
    if grand_total > 0:
        lines.append("")
        lines.append("\u2500" * 30)
        lines.append(f"\U0001f4ca Run rate: ${grand_total:.2f}/day \u00b7 ${grand_total * 30:.2f}/mo")

    # Zero-usage case
    if not key_totals:
        lines = [
            "\U0001f4b0 OPENCLAW DAILY API SPEND",
            f"\U0001f4c5 {date_str} (last {hours}h)",
            "",
            "\u2705 No API usage recorded in the last 24h.",
            "Either nothing ran, or the logger isn't hooked up.",
        ]

    return "\n".join(lines)


def send_telegram(message: str) -> bool:
    """Send message via Telegram Bot API."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.", file=sys.stderr)
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": message}
    try:
        resp = requests.post(url, json=payload, timeout=15)
        if resp.status_code >= 400:
            print(f"Telegram HTTP error: status={resp.status_code}", file=sys.stderr)
            return False
        result = resp.json()
        if result.get("ok"):
            print(f"Telegram message sent to chat {TELEGRAM_CHAT_ID}")
            return True
        else:
            print(f"Telegram API error: {result}", file=sys.stderr)
            return False
    except Exception:
        print("Failed to send Telegram message due to network/transport error.", file=sys.stderr)
        return False


def run_report(hours: int = 24, test_mode: bool = False):
    """Main entry point — query, format, send."""
    key_totals = query_totals_by_key(hours)
    model_details = query_local_usage(hours)
    message = format_telegram_message(key_totals, model_details, hours)

    if test_mode:
        print("=== TEST MODE \u2014 Message Preview ===\n")
        print(message)
        print("\n=== End Preview ===")
        return

    success = send_telegram(message)
    if not success:
        fallback_path = os.path.expanduser("~/.openclaw/spend_report_fallback.log")
        with open(fallback_path, "a") as f:
            f.write(f"\n{'=' * 40}\n{datetime.now().isoformat()}\n{message}\n")
        print(f"Fallback: report written to {fallback_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OpenClaw Daily API Spend Reporter")
    parser.add_argument("--test", action="store_true", help="Preview message without sending")
    parser.add_argument("--hours", type=int, default=24, help="Lookback window (default: 24)")
    args = parser.parse_args()
    run_report(hours=args.hours, test_mode=args.test)
