---
name: enable-sharing
description: Enable on-demand CopyLobsta sharing mode for this bot.
user-invocable: true
---

# Enable Sharing

When the user invokes `/enable-sharing`, do the following on this machine:

1. Ensure `~/.openclaw/.env` exists.
2. Ensure `COPYLOBSTA_LAUNCH_SECRET` is set in `~/.openclaw/.env`.
3. Set `COPYLOBSTA_SHARING_MODE=on_demand` in `~/.openclaw/.env`.
4. Restart the CopyLobsta service:
   - `systemctl --user restart copylobsta`
5. Verify health locally:
   - `curl -sf http://127.0.0.1:${COPYLOBSTA_PORT:-3457}/health`

If successful, reply with:
- Sharing is enabled in on-demand mode.
- `/copylobsta` will start a temporary secure tunnel per onboarding session.

If health check fails, reply with the exact failure and ask the user to run:
- `systemctl --user status copylobsta`
- `journalctl --user -u copylobsta -n 100 --no-pager`
