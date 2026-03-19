#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  exit 1
fi

VERSION="$1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be semver, e.g. 1.0.0"
  exit 1
fi

cd "$REPO_ROOT/agents/main/skills/copylobsta/server"
npm test

cd "$REPO_ROOT/agents/main/skills/copylobsta/setup-api"
npm test

cd "$REPO_ROOT"
git tag "v$VERSION"
git push origin "v$VERSION"

echo "Released v$VERSION"
echo "Reminder: set COPYLOBSTA_RELEASE_TAG=v$VERSION on active hosts."
