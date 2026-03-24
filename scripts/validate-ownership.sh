#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_DIR="$ROOT_DIR/agents/main/skills/copylobsta"

if [ ! -d "$SKILL_DIR" ]; then
  echo "Missing CopyLobsta skill directory: $SKILL_DIR" >&2
  exit 1
fi

if [ -L "$SKILL_DIR" ]; then
  echo "CopyLobsta source of truth must live in the copylobsta repo, but $SKILL_DIR is a symlink." >&2
  exit 1
fi

CLAWDIA_DIR="${CLAWDIA_REPO_DIR:-/home/openclaw/clawdia-hertz-openclaw}"
CLAWDIA_LINK="$CLAWDIA_DIR/agents/clawdia/skills/copylobsta"
if [ -e "$CLAWDIA_LINK" ]; then
  if [ ! -L "$CLAWDIA_LINK" ]; then
    echo "Expected $CLAWDIA_LINK to be a symlink into copylobsta." >&2
    exit 1
  fi
  resolved="$(readlink -f "$CLAWDIA_LINK")"
  expected="$(readlink -f "$SKILL_DIR")"
  if [ "$resolved" != "$expected" ]; then
    echo "Clawdia copylobsta link target mismatch: $resolved != $expected" >&2
    exit 1
  fi
fi

echo "[ownership] ok"
