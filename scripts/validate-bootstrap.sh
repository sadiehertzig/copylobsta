#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[bootstrap] syntax check"
bash -n setup/install.sh
bash -n scripts/sync-template-s3.sh

echo "[bootstrap] required file check"
required_files=(
  "setup/.env.example"
  "setup/openclaw.json.template"
  "scripts/injection_scan.sh"
  "agents/main/skills/copylobsta/run_spotlight.sh"
  "agents/main/skills/copylobsta/copylobsta.service"
  "agents/main/skills/copylobsta/server/package.json"
  "agents/main/skills/copylobsta/setup-api/package.json"
  "infra/openclaw-runtime.yaml"
)

for path in "${required_files[@]}"; do
  if [ ! -e "$path" ]; then
    echo "Missing bootstrap/runtime dependency: $path" >&2
    exit 1
  fi
done

echo "[bootstrap] user-data path check"
grep -q 'bash setup/install.sh' infra/openclaw-runtime.yaml
grep -q 'copylobsta-setup-api-src' infra/openclaw-runtime.yaml
grep -q 'COPYLOBSTA_REPO_DIR' setup/install.sh

echo "[bootstrap] ok"
