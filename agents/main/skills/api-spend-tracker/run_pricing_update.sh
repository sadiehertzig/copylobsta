#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
set -a
source "$HOME/.openclaw/.env"
set +a
cd "$SCRIPT_DIR"
mkdir -p "$REPO_DIR/logs"
/usr/bin/python3 scripts/update_pricing.py >> "$REPO_DIR/logs/pricing_update.log" 2>&1
