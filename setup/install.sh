#!/usr/bin/env bash
# CopyLobsta — OpenClaw Instance Setup Script
# Supports both interactive (manual) and non-interactive (CopyLobsta automated) modes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_DIR="$HOME/.openclaw"
ENV_FILE="$OPENCLAW_DIR/.env"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"

echo "=== CopyLobsta Setup ==="
echo "Repo directory: $REPO_DIR"

# --- Check Node.js ---
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 20+ first."
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js $NODE_VERSION found, but 20+ is required."
  exit 1
fi
echo "Node.js $(node -v) found."

# --- Install OpenClaw globally ---
if ! command -v openclaw &>/dev/null; then
  echo "Installing openclaw..."
  npm install -g openclaw
else
  echo "openclaw already installed: $(openclaw --version 2>/dev/null || echo 'unknown version')"
fi

# --- Create ~/.openclaw/ ---
mkdir -p "$OPENCLAW_DIR"

# --- Copy .env template if not exists ---
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/setup/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE — edit it to add your API keys and bot token."
else
  echo "$ENV_FILE already exists — skipping."
fi

# --- Persist repo dir so services/scripts can resolve paths without ~/copylobsta assumptions ---
if ! grep -q '^COPYLOBSTA_REPO_DIR=' "$ENV_FILE" 2>/dev/null; then
  echo "" >> "$ENV_FILE"
  echo "# Auto-generated CopyLobsta repository root" >> "$ENV_FILE"
  echo "COPYLOBSTA_REPO_DIR=$REPO_DIR" >> "$ENV_FILE"
  echo "Saved COPYLOBSTA_REPO_DIR to $ENV_FILE"
fi

# --- Generate gateway token if not set ---
if ! grep -q "OPENCLAW_GATEWAY_TOKEN=" "$ENV_FILE" 2>/dev/null || \
   grep -q "OPENCLAW_GATEWAY_TOKEN=$" "$ENV_FILE" 2>/dev/null; then
  TOKEN=$(openssl rand -hex 32)
  echo "" >> "$ENV_FILE"
  echo "# Auto-generated gateway token" >> "$ENV_FILE"
  echo "OPENCLAW_GATEWAY_TOKEN=$TOKEN" >> "$ENV_FILE"
  echo "Generated gateway token."
fi

# --- Set TRIVIA_VOICE_BASE_URL if not set ---
if ! grep -q "TRIVIA_VOICE_BASE_URL=" "$ENV_FILE" 2>/dev/null || \
   grep -q "TRIVIA_VOICE_BASE_URL=$" "$ENV_FILE" 2>/dev/null; then
  TRIVIA_PORT=$(grep "^TRIVIA_PORT=" "$ENV_FILE" 2>/dev/null | cut -d= -f2)
  TRIVIA_PORT="${TRIVIA_PORT:-3456}"
  sed -i "s|^TRIVIA_VOICE_BASE_URL=.*|TRIVIA_VOICE_BASE_URL=http://localhost:$TRIVIA_PORT|" "$ENV_FILE" 2>/dev/null || \
    echo "TRIVIA_VOICE_BASE_URL=http://localhost:$TRIVIA_PORT" >> "$ENV_FILE"
  echo "Set TRIVIA_VOICE_BASE_URL=http://localhost:$TRIVIA_PORT"
fi

# --- Generate CopyLobsta launch secret if not set ---
if ! grep -q "COPYLOBSTA_LAUNCH_SECRET=" "$ENV_FILE" 2>/dev/null || \
   grep -q "COPYLOBSTA_LAUNCH_SECRET=$" "$ENV_FILE" 2>/dev/null; then
  LAUNCH_SECRET=$(openssl rand -hex 32)
  echo "" >> "$ENV_FILE"
  echo "# Auto-generated launch secret (host bot -> copylobsta server auth)" >> "$ENV_FILE"
  echo "COPYLOBSTA_LAUNCH_SECRET=$LAUNCH_SECRET" >> "$ENV_FILE"
  echo "Generated COPYLOBSTA_LAUNCH_SECRET."
fi

# --- Create openclaw.json config ---
if [ ! -f "$CONFIG_FILE" ]; then
  sed "s|__REPO_DIR__|$REPO_DIR|g" "$REPO_DIR/setup/openclaw.json.template" > "$CONFIG_FILE"
  echo "Created $CONFIG_FILE"
else
  echo "$CONFIG_FILE already exists — skipping."
fi

# --- Install skill server dependencies ---
echo ""
echo "Installing skill server dependencies..."

# Voice Trivia server
if [ -f "$REPO_DIR/agents/main/skills/voice-trivia/server/package.json" ]; then
  echo "  Installing voice-trivia server deps..."
  (cd "$REPO_DIR/agents/main/skills/voice-trivia/server" && npm install --production)
fi

# CopyLobsta server
if [ -f "$REPO_DIR/agents/main/skills/copylobsta/server/package.json" ]; then
  echo "  Installing copylobsta server deps..."
  (cd "$REPO_DIR/agents/main/skills/copylobsta/server" && npm install && npm run build)
  if [ $? -ne 0 ]; then
    echo "  WARNING: CopyLobsta server build failed. The copylobsta service may not start."
  fi
fi

# --- Install systemd services ---
echo ""
echo "Setting up systemd services..."
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

# OpenClaw gateway service (always refresh template for safe defaults)
cat > "$SYSTEMD_DIR/openclaw-gateway.service" <<EOT
[Unit]
Description=OpenClaw Gateway
After=network-online.target

[Service]
Type=simple
ExecStart=$(command -v openclaw || echo /usr/bin/openclaw) gateway --port 18789
Restart=always
RestartSec=5
EnvironmentFile=-%h/.openclaw/.env
ExecStartPre=/usr/bin/test -r /home/openclaw/.openclaw/.env
ExecStartPre=/usr/bin/grep -q ^OPENCLAW_GATEWAY_TOKEN=. /home/openclaw/.openclaw/.env

[Install]
WantedBy=default.target
EOT
echo "  Installed openclaw-gateway.service"

# Copy skill services (always refresh templates for safety updates)
for service in voice-trivia/trivia-voice.service copylobsta/copylobsta.service; do
  SERVICE_FILE="$REPO_DIR/agents/main/skills/$service"
  SERVICE_NAME=$(basename "$service")
  if [ -f "$SERVICE_FILE" ]; then
    # Expand the service template's repo path to this install location.
    # systemd WorkingDirectory does not expand shell/env vars.
    sed -e "s#%h/copylobsta#$REPO_DIR#g" \
        -e "s#%h/clawdia-hertz-openclaw#$REPO_DIR#g" \
        "$SERVICE_FILE" > "$SYSTEMD_DIR/$SERVICE_NAME"
    echo "  Installed $SERVICE_NAME"
  fi
done

systemctl --user daemon-reload 2>/dev/null || true

# --- Bootstrap self-improving skill memory ---
echo ""
echo "Setting up self-improving skill..."
SI_DIR="$HOME/self-improving"
if [ ! -d "$SI_DIR" ]; then
  mkdir -p "$SI_DIR"/{projects,domains,archive}

  cat > "$SI_DIR/memory.md" <<'SIEOF'
# Self-Improving Memory

## Confirmed Preferences
<!-- Patterns confirmed by user, never decay -->

## Active Patterns
<!-- Patterns observed 3+ times, subject to decay -->

## Recent (last 7 days)
<!-- New corrections pending confirmation -->
SIEOF

  cat > "$SI_DIR/index.md" <<'SIEOF'
# Memory Index

## HOT
- memory.md: 0 lines

## WARM
- (no namespaces yet)

## COLD
- (no archives yet)

Last compaction: never
SIEOF

  cat > "$SI_DIR/corrections.md" <<'SIEOF'
# Corrections Log

<!-- Format:
## YYYY-MM-DD
- [HH:MM] Changed X → Y
  Type: format|technical|communication|project
  Context: where correction happened
  Confirmed: pending (N/3) | yes | no
-->
SIEOF

  cat > "$SI_DIR/heartbeat-state.md" <<'SIEOF'
# Self-Improving Heartbeat State

last_heartbeat_started_at: never
last_reviewed_change_at: never
last_heartbeat_result: never

## Last actions
- none yet
SIEOF

  echo "  Created ~/self-improving/ with seed files."
else
  echo "  ~/self-improving/ already exists — skipping."
fi

# --- Schedule daily injection scan via cron ---
echo ""
echo "Setting up daily injection scan..."
SCAN_SCRIPT="$REPO_DIR/scripts/injection_scan.sh"
mkdir -p "$REPO_DIR/logs"
if [ -f "$SCAN_SCRIPT" ]; then
  chmod +x "$SCAN_SCRIPT"
  CRON_ENTRY="0 3 * * * $SCAN_SCRIPT >> $REPO_DIR/logs/injection_scan.log 2>&1 # openclaw-injection-scan"
  if crontab -l 2>/dev/null | grep -q "openclaw-injection-scan"; then
    echo "  Injection scan cron already exists — skipping."
  else
    (crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -
    echo "  Scheduled daily injection scan at 3 AM."
  fi
fi

# --- Schedule daily spotlight ---
echo ""
echo "Setting up daily skill spotlight..."
SPOTLIGHT_SCRIPT="$REPO_DIR/agents/main/skills/copylobsta/run_spotlight.sh"
if [ -f "$SPOTLIGHT_SCRIPT" ]; then
  chmod +x "$SPOTLIGHT_SCRIPT"
  SPOTLIGHT_CRON="30 11 * * * $SPOTLIGHT_SCRIPT >> $REPO_DIR/logs/spotlight_cron.log 2>&1 # openclaw-spotlight"
  if crontab -l 2>/dev/null | grep -q "openclaw-spotlight"; then
    echo "  Spotlight cron already exists — skipping."
  else
    (crontab -l 2>/dev/null; echo "$SPOTLIGHT_CRON") | crontab -
    echo "  Scheduled daily spotlight at 11:30 UTC."
  fi
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $ENV_FILE with your API keys and bot token"
echo "  2. Edit $REPO_DIR/SOUL.md to customize your bot's personality"
echo "  3. Edit $REPO_DIR/USER.md to tell your bot about yourself"
echo "  4. Start the gateway: systemctl --user start openclaw-gateway"
echo "  5. (Optional) Start Mini App services:"
echo "     systemctl --user start trivia-voice"
echo "     systemctl --user start copylobsta"
echo ""
