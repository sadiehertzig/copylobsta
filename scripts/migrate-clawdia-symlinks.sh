#!/usr/bin/env bash
set -euo pipefail

SKILLS_DIR="/home/ubuntu/clawdia-hertz-openclaw/agents/clawdia/skills"
SOURCE_DIR="/home/openclaw/copylobsta/agents/main/skills"
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

for skill in "${SYMLINKED[@]}"; do
  target="$SKILLS_DIR/$skill"
  source="$SOURCE_DIR/$skill"

  if [ -L "$target" ]; then
    if ! diff -rq "$target/" "$source/" >/dev/null 2>&1; then
      echo "WARNING: $skill has local differences before migration"
    fi
    rm "$target"
    cp -r "$source" "$target"
    echo "Migrated: $skill"
  else
    echo "Skip (not symlink): $skill"
  fi
done

echo "Done. Review changes in /home/ubuntu/clawdia-hertz-openclaw and commit when ready."
