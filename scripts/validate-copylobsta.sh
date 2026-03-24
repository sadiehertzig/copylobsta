#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/validate-ownership.sh
./scripts/validate-bootstrap.sh

if [[ -z "${CFN_TEMPLATE_MODE:-}" && -z "${CFN_TEMPLATE_SOURCE:-}" && -z "${CFN_TEMPLATE_URL:-}" ]]; then
  export CFN_TEMPLATE_URL="https://example.invalid/copylobsta/template.yaml"
fi

(
  cd agents/main/skills/copylobsta/server
  npm test
  npm run build
)

(
  cd agents/main/skills/copylobsta/setup-api
  npm test
  npm run build
)

node scripts/smoke-aws-launch.mjs
