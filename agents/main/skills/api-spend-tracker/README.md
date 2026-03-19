# API Spend Tracker

Tracks API usage costs across Anthropic, OpenAI, and Google providers. Stores usage in SQLite and sends daily Telegram digests.

## Usage

- "Show my API spend"
- "How much have I spent on API calls?"
- "Send a spend report"

## How It Works

1. A lightweight HTTP server (`log_server.py`) receives usage logs on port 9147
2. Each log entry is stored in `~/.openclaw/api_usage.db` (SQLite)
3. A daily cron job runs `reporter.py` to generate and send a Telegram digest
4. Cost is calculated from per-model pricing tables in `cost_tables.py`

## Integration

Other skills (like three-body-council) auto-log API calls. To integrate a custom skill:

```python
import os, sys
_tracker_dir = os.path.join(os.path.dirname(__file__), "..", "api-spend-tracker", "scripts")
sys.path.insert(0, _tracker_dir)
from openclaw_integration import patch_anthropic_client
patch_anthropic_client(client, api_key_label="my-label")
```

## Setup

```bash
# Start the log server
python3 scripts/log_server.py

# Test the reporter
python3 scripts/reporter.py --test

# Send a live report
python3 scripts/reporter.py
```

### Environment Variables

- `SPEND_TRACKER_PORT` — Log server port (default: 9147)
- `SPEND_TRACKER_DB` — SQLite database path (default: `~/.openclaw/api_usage.db`)
- `OPENCLAW_TELEGRAM_BOT_TOKEN` — For sending digest reports
- `OPENCLAW_TELEGRAM_CHAT_ID` — Chat to send digests to

## Dependencies

- Python 3.11+
- SQLite3 (built into Python)

## License

MIT
