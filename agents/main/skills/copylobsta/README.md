# CopyLobsta

Community growth skill that walks friends through setting up their own OpenClaw bot instance. Guides users through AWS setup, API keys, BotFather, a personality interview (soul doc), and automated deployment.

## Usage

In a group chat or DM:
- "/copylobsta"

## How It Works

1. Posts a "Let's do it" button that opens the CopyLobsta Mini App
2. Guides the friend through:
   - AWS account + CloudFormation stack setup
   - API key entry (Anthropic, Gemini, OpenAI) via secure Mini App
   - Telegram BotFather bot creation
   - Soul interview (10 questions to define bot personality)
   - User interview (10 questions to define user profile)
   - Automated deployment via SSM
3. Friend ends up with their own bot on their own infrastructure

## Setup

The CopyLobsta Mini App requires a running Express server:

```bash
cd server && npm install && npm run build
node dist/index.js
```

### Environment Variables

- `COPYLOBSTA_PORT` — Server port (default: 3457)
- `COPYLOBSTA_SHARING_MODE` — `disabled` (default) or `on_demand`
- `COPYLOBSTA_LAUNCH_SECRET` — Shared secret required for `/api/launch`
- `COPYLOBSTA_SHARING_TTL_MINUTES` — Optional on-demand tunnel lifetime (default: 45)
- `OPENCLAW_TELEGRAM_BOT_TOKEN` — Telegram bot token
- `OPENCLAW_TELEGRAM_CHAT_ID` — Default chat ID

### Systemd Service

Install `copylobsta.service` to run as a background service.

## Testing

```bash
# Server tests (55 tests)
cd server && npm test

# Setup API tests (18 tests)
cd setup-api && npm test
```

Tests cover: state machine transitions, session CRUD with locking, secret detection/redaction, Telegram HMAC auth, key validation (mocked), and AWS Secrets Manager writes (mocked).

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues with:
- CloudFormation stack failures
- Instance connection problems
- API key validation errors
- Deployment failures
- Cost management

## Dependencies

- Node.js >= 20
- TypeScript (compiled to dist/)
- Telegram bot token
- AWS credentials (for CloudFormation + SSM deployment)

## License

MIT
