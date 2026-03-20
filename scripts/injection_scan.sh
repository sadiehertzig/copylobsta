#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# OpenClaw Daily Prompt Injection Scan
# Schedule: 3 AM daily via cron
# Action: report only — never modifies or deletes files
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

# ─── LOAD ENV ────────────────────────────────────────────────────
if [ -f "$HOME/.openclaw/.env" ]; then
  set -a
  source "$HOME/.openclaw/.env"
  set +a
fi

# ─── CONFIGURATION ───────────────────────────────────────────────
TELEGRAM_TOKEN="${OPENCLAW_TELEGRAM_BOT_TOKEN:-}"
CHAT_IDS=("${OPENCLAW_TELEGRAM_CHAT_ID:-}")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── DERIVED PATHS ────────────────────────────────────────────────
AGENT_DIRS=("${BASE_DIR}/agents/main")

SCAN_DATE=$(date +"%Y-%m-%d")
SCAN_TIME=$(date +"%Y-%m-%d %H:%M:%S %Z")
YESTERDAY=$(date -d "yesterday" +"%Y-%m-%d" 2>/dev/null || date -v-1d +"%Y-%m-%d")

# ─── STATE ───────────────────────────────────────────────────────
ALERTS=""
ALERT_COUNT=0

# ─── FUNCTIONS ───────────────────────────────────────────────────
flag() {
  local file="$1" line="$2" reason="$3" content="$4"
  ALERT_COUNT=$((ALERT_COUNT + 1))
  content="$(redact_sensitive "$content")"
  if [ ${#content} -gt 200 ]; then
    content="${content:0:200}..."
  fi
  ALERTS="${ALERTS}
⚠ #${ALERT_COUNT}
File: ${file}
Line: ${line}
Reason: ${reason}
Content: ${content}
"
}

redact_sensitive() {
  local text="$1"
  text="$(printf '%s' "$text" | sed -E 's/([?&](key|api_key|token)=)[^&[:space:]]+/\1[REDACTED]/Ig')"
  text="$(printf '%s' "$text" | sed -E 's/(Bearer[[:space:]]+)[A-Za-z0-9._-]+/\1[REDACTED]/Ig')"
  text="$(printf '%s' "$text" | sed -E 's/((api[_-]?key|token|secret|password)[[:space:]]*[:=][[:space:]]*)[^[:space:],;]+/\1[REDACTED]/Ig')"
  printf '%s' "$text"
}

send_telegram() {
  local msg="$1"
  if [ -z "${TELEGRAM_TOKEN}" ]; then
    echo "[warn] OPENCLAW_TELEGRAM_BOT_TOKEN not configured; skipping Telegram notification"
    return 0
  fi
  msg="$(redact_sensitive "$msg")"
  if [ ${#msg} -gt 4000 ]; then
    msg="${msg:0:3990}
... [truncated — ${ALERT_COUNT} total findings]"
  fi
  for cid in "${CHAT_IDS[@]}"; do
    [ -n "${cid}" ] || continue
    if ! curl -s --max-time 8 -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      -d chat_id="${cid}" \
      -d text="${msg}" \
      -d parse_mode="Markdown" > /dev/null 2>&1; then
      curl -s --max-time 8 -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
        -d chat_id="${cid}" \
        -d text="${msg}" > /dev/null 2>&1 || true
    fi
  done
}

# ═══════════════════════════════════════════════════════════════════
# SCAN 1: Injection keywords (case-insensitive)
# ═══════════════════════════════════════════════════════════════════
KEYWORDS=(
  "ignore previous"
  "ignore all instructions"
  "disregard.*instructions"
  "jailbreak"
  "override instructions"
  "new instructions"
  "forget your"
  "you are now"
  "WORKFLOW_AUTO"
  "pretend you are"
  "roleplay as"
  "bypass safety"
  "ignore all previous"
  "system prompt"
  "reveal your instructions"
  "act as if"
  "do not follow"
  "do anything now"
)

for dir in "${AGENT_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  for kw in "${KEYWORDS[@]}"; do
    while IFS=: read -r file lineno content; do
      [[ "$file" == *"injection_scan"* ]] && continue
      flag "$file" "$lineno" "Injection keyword: '${kw}'" "$content"
    done < <(grep -rni "${kw}" "${dir}" 2>/dev/null || true)
  done
done

# ═══════════════════════════════════════════════════════════════════
# SCAN 2: Hidden unicode / zero-width characters
# ═══════════════════════════════════════════════════════════════════
for dir in "${AGENT_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS=: read -r file lineno content; do
    [[ "$file" == *"injection_scan"* ]] && continue
    flag "$file" "$lineno" "Hidden unicode / zero-width character" "$content"
  done < <(grep -rnP '[\x{200B}\x{200C}\x{200D}\x{200E}\x{200F}\x{FEFF}\x{00AD}\x{2060}\x{2061}\x{2062}\x{2063}\x{2064}]' "${dir}" 2>/dev/null || true)
done

# ═══════════════════════════════════════════════════════════════════
# SCAN 3: Embedded JWT tokens
# ═══════════════════════════════════════════════════════════════════
for dir in "${AGENT_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS=: read -r file lineno content; do
    [[ "$file" == *"injection_scan"* ]] && continue
    basename_file=$(basename "$file")
    if [ "$basename_file" != "TOOLS.md" ]; then
      flag "$file" "$lineno" "Possible JWT token" "$content"
    fi
  done < <(grep -rnP 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' "${dir}" 2>/dev/null || true)
done

# ═══════════════════════════════════════════════════════════════════
# SCAN 4: URLs not on the allowlist
# ═══════════════════════════════════════════════════════════════════
ALLOWED='(192\.168\.[0-9]+\.[0-9]+|localhost|127\.0\.0\.1|openclaw\.ai|github\.com|clawhub\.com|telegram\.org|npmjs\.com|deb\.nodesource\.com|api\.telegram\.org)'

for dir in "${AGENT_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS=: read -r file lineno content; do
    [[ "$file" == *"injection_scan"* ]] && continue
    urls=$(echo "$content" | grep -oP 'https?://[^\s"'"'"'<>\)]+' || true)
    for url in $urls; do
      if ! echo "$url" | grep -qiP "$ALLOWED"; then
        flag "$file" "$lineno" "URL not on allowlist" "$url"
      fi
    done
  done < <(grep -rnP 'https?://' "${dir}" 2>/dev/null || true)
done

# ═══════════════════════════════════════════════════════════════════
# SCAN 5: Unexpected .md files modified in last 24 hours
# ═══════════════════════════════════════════════════════════════════
EXPECTED_TOP_LEVEL="MEMORY.md TOOLS.md HEARTBEAT.md"

for dir in "${AGENT_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  agent_name=$(basename "$dir")

  while IFS= read -r md_file; do
    relative="${md_file#${dir}/}"
    is_expected=false

    for exp in $EXPECTED_TOP_LEVEL; do
      [ "$relative" = "$exp" ] && is_expected=true && break
    done

    [ "$relative" = "memory/${SCAN_DATE}.md" ] && is_expected=true
    [ "$relative" = "memory/${YESTERDAY}.md" ] && is_expected=true

    if [ "$is_expected" = false ]; then
      mod_time=$(stat -c '%y' "$md_file" 2>/dev/null || stat -f '%Sm' "$md_file" 2>/dev/null || echo "unknown")
      flag "$md_file" "N/A" "Unexpected .md modified (agent: ${agent_name})" "Last modified: ${mod_time}"
    fi
  done < <(find "${dir}" -name "*.md" -mtime -1 2>/dev/null || true)
done

# ═══════════════════════════════════════════════════════════════════
# REPORT
# ═══════════════════════════════════════════════════════════════════
if [ "$ALERT_COUNT" -eq 0 ]; then
  send_telegram "🟢 Daily injection scan: all clear — ${SCAN_DATE}"
  echo "[${SCAN_TIME}] Scan complete: clean"
else
  HEADER="🔴 *OpenClaw Injection Scan — ${SCAN_DATE}*
Found *${ALERT_COUNT}* suspicious item(s):
"
  send_telegram "${HEADER}${ALERTS}"
  echo "[${SCAN_TIME}] Scan complete: ${ALERT_COUNT} finding(s) reported"
fi

exit 0
