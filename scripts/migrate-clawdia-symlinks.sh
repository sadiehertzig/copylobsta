#!/usr/bin/env bash
set -euo pipefail

CANONICAL_WORKSPACE="${CLAWDIA_WORKSPACE_ROOT:-/home/openclaw/clawdia-hertz-openclaw}"
SKILLS_DIR="${CLAWDIA_SKILLS_DIR:-$CANONICAL_WORKSPACE/agents/clawdia/skills}"
SOURCE_DIR="${COPYLOBSTA_SKILLS_SOURCE_DIR:-/home/openclaw/copylobsta/agents/main/skills}"
DRY_RUN=false

SYMLINKED=(
  copylobsta
  autoimprove-tbc
  three-body-council
  voice-trivia
  creative-writing
  api-spend-tracker
  quiz-me
  code-tutor
  college-essay
  notes-quiz
)

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--dry-run]

Migrates selected symlinked skills in Clawdia workspace to local directories.

Environment overrides:
  CLAWDIA_WORKSPACE_ROOT      default: /home/openclaw/clawdia-hertz-openclaw
  CLAWDIA_SKILLS_DIR          default: \$CLAWDIA_WORKSPACE_ROOT/agents/clawdia/skills
  COPYLOBSTA_SKILLS_SOURCE_DIR default: /home/openclaw/copylobsta/agents/main/skills
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$SKILLS_DIR" ]]; then
  echo "Missing skills directory: $SKILLS_DIR" >&2
  exit 1
fi
if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Missing source directory: $SOURCE_DIR" >&2
  exit 1
fi

for skill in "${SYMLINKED[@]}"; do
  target="$SKILLS_DIR/$skill"
  source="$SOURCE_DIR/$skill"

  if [[ ! -d "$source" ]]; then
    echo "Skip (missing source): $skill"
    continue
  fi

  if [[ -L "$target" ]]; then
    if ! diff -rq "$target/" "$source/" >/dev/null 2>&1; then
      echo "WARNING: $skill has local differences before migration"
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
      echo "[dry-run] Would migrate: $skill"
      continue
    fi

    rm "$target"
    cp -r "$source" "$target"
    echo "Migrated: $skill"
  else
    echo "Skip (not symlink): $skill"
  fi
done

echo "Done. Review changes in $CANONICAL_WORKSPACE and commit when ready."
