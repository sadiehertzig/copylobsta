#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
set -a
source "$HOME/.openclaw/.env"
set +a
cd "$SCRIPT_DIR"
mkdir -p "$REPO_DIR/logs"
/usr/bin/python3 scripts/reporter.py >> "$REPO_DIR/logs/spend_cron.log" 2>&1
