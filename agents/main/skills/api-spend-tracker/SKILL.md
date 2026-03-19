---
name: api-spend-tracker
description: Tracks API spending across Anthropic, OpenAI, and Google keys with SQLite storage and daily Telegram digests
user-invocable: true
metadata:
  author: "OpenClaw Community"
  homepage: "https://github.com/sadiehertzig/CopyLobsta"
---

# API Spend Tracker

Track and report API usage costs across all providers.

## Commands

- **Show current spend**: Query the SQLite database and display a formatted summary
- **Test report**: Run `python3 scripts/reporter.py --test` to preview the daily digest
- **Send report now**: Run `python3 scripts/reporter.py` to send a live Telegram report
- **Custom window**: Run `python3 scripts/reporter.py --test --hours 48` for a wider lookback

## How It Works

1. Every LLM API call is logged to `~/.openclaw/api_usage.db` via `log_usage()`
2. A cron job runs daily at 8am ET, querying the last 24h and sending a Telegram digest
3. Cost is calculated from per-model pricing tables in `scripts/cost_tables.py`

## Integration

The three-body-council skill auto-logs all its API calls. For other skills that use SDK clients directly, use the monkey-patch integration:

```python
import os, sys
# Auto-discover the spend tracker scripts directory (sibling skill)
_tracker_dir = os.path.join(os.path.dirname(__file__), "..", "api-spend-tracker", "scripts")
sys.path.insert(0, _tracker_dir)
from openclaw_integration import patch_anthropic_client
patch_anthropic_client(client, api_key_label="my-label")
```

## Updating Pricing

Edit `scripts/cost_tables.py` when providers change their rates.
