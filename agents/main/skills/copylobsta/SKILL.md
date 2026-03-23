---
name: copylobsta
description: Help friends get their own OpenClaw bot — guided setup via Telegram Mini App.
user-invocable: true
---

# CopyLobsta

## When the user invokes /copylobsta (Telegram group or DM)

Use bash to POST to the local CopyLobsta server `/api/launch` endpoint.
The `web_app` button only works in DMs. In group chats the server will
automatically DM the user (using `user_id`) and post a notice in the group.

**From a DM:**
```bash
curl -s -X POST "http://127.0.0.1:${COPYLOBSTA_PORT:-3457}/api/launch" \
  -H "Content-Type: application/json" \
  -H "x-launch-secret: ${COPYLOBSTA_LAUNCH_SECRET}" \
  -d '{"chat_id":"<the chat id>"}'
```

**From a group chat:** pass the group's chat ID as both `chat_id` and `group_id`,
and always include `user_id` (the Telegram user ID of the person who invoked the
command) so the server can DM them the setup button.
```bash
curl -s -X POST "http://127.0.0.1:${COPYLOBSTA_PORT:-3457}/api/launch" \
  -H "Content-Type: application/json" \
  -H "x-launch-secret: ${COPYLOBSTA_LAUNCH_SECRET}" \
  -d '{"chat_id":"<the group chat id>","group_id":"<the group chat id>","user_id":"<invoking user telegram id>"}'

# Optional: force a clean restart for this user only
# Add "fresh": true to the JSON body.
# Example:
# -d '{"chat_id":"<group>","group_id":"<group>","user_id":"<user>","fresh":true}'
```

The server will:
1. Verify sharing mode and launch secret
2. Start a temporary HTTPS Cloudflare quick tunnel
3. Send a "Let's do it" Mini App button to the chat
4. Tear down sharing automatically when onboarding completes or times out

If the API returns `503` with "Sharing is not enabled":
- Reply: "Sharing isn't enabled on this bot yet. The owner can enable it with `/enable-sharing`."

If launch succeeds, reply:
- "I just sent the CopyLobsta setup button — tap 'Let's do it' to get started with your own bot!"

If launch fails for other reasons, reply:
- "CopyLobsta couldn't start a secure sharing session right now. Try again in a minute, or check `systemctl --user status copylobsta`."

## What CopyLobsta Does

CopyLobsta walks a friend through setting up their own OpenClaw instance:
1. AWS account + CloudFormation stack
2. API keys (Anthropic, Gemini, OpenAI)
3. Telegram BotFather setup
4. Soul interview (personality for their bot)
5. Deployment via SSM

All sensitive steps (key entry, deployment status) happen in the Mini App, not in chat.

## Tone

- Friendly, encouraging, never condescending
- Like a friend helping you set up your first computer
- Clear about costs (~$37/month AWS + $10-30/month APIs)
