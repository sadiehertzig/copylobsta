#!/bin/bash
set -euo pipefail

if [ -f "$HOME/.openclaw/.env" ]; then
  set -a
  source "$HOME/.openclaw/.env"
  set +a
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${COPYLOBSTA_REPO_DIR:-$(cd "$SCRIPT_DIR/../../../../.." && pwd)}"

cd "$SCRIPT_DIR/server"
mkdir -p "$REPO_DIR/logs"
/usr/bin/node dist/spotlight.js >> "$REPO_DIR/logs/spotlight_cron.log" 2>&1
