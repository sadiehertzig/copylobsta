# CopyLobsta

> ⚠️ **HEADS UP:** This project was built by a solo rookie developer and has not been professionally audited. Do not share sensitive personal information, API keys, or passwords with the bot. Use at your own risk.

An OpenClaw distribution repo — clone it, run setup, and you've got a working AI bot on Telegram with 11 skills out of the box.

CopyLobsta is designed to be deployed automatically by the [CopyLobsta skill](agents/main/skills/copylobsta/) during friend onboarding, but it also works perfectly for manual setup.

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/OpenClaw/CopyLobsta.git ~/copylobsta
cd ~/copylobsta

# 2. Run the setup script
bash setup/install.sh

# 3. Add your API keys and bot token
nano ~/.openclaw/.env

# 4. Start the gateway
systemctl --user start openclaw-gateway

# 5. Talk to your bot on Telegram!
```

### Prerequisites

- **Node.js 20+** — the setup script will check for this
- **A Telegram bot token** — get one from [@BotFather](https://t.me/BotFather)
- **At least one AI provider API key** — Anthropic, OpenAI, or Google Gemini

## Skills

CopyLobsta ships with 11 skills:

| Skill | Description | Type |
|-------|-------------|------|
| [quiz-me](agents/main/skills/quiz-me/) | Adaptive quiz generation on any topic | Prompt |
| [notes-quiz](agents/main/skills/notes-quiz/) | Generate quizzes from uploaded notes/documents | Prompt |
| [academic-deep-research](agents/main/skills/academic-deep-research/) | Rigorous academic research — 2-cycle methodology, APA citations, evidence hierarchy ([kesslerio](https://github.com/kesslerio/academic-deep-research-clawhub-skill)) | Prompt |
| [creative-writing](agents/main/skills/creative-writing/) | Writing partner — free-write, worldbuilding, feedback | Prompt |
| [code-tutor](agents/main/skills/code-tutor/) | Learn to code with hints-first teaching | Prompt |
| [college-essay](agents/main/skills/college-essay/) | College application essay coaching (coaching only — won't write for you) | Prompt |
| [three-body-council](agents/main/skills/three-body-council/) | Multi-model debate for complex questions | Python |
| [autoimprove-tbc](agents/main/skills/autoimprove-tbc/) | Three-Body Council self-improvement loop with fuzzy-task auto-detection — grades via multi-model panel, ratchets quality up | Python |
| [voice-trivia](agents/main/skills/voice-trivia/) | Real-time voice trivia game via Telegram Mini App | Express.js |
| [copylobsta](agents/main/skills/copylobsta/) | Share your bot with friends (deploys new instances) | TypeScript |
| [api-spend-tracker](agents/main/skills/api-spend-tracker/) | Track API costs across providers | Python |

## Daily Skill Spotlight

New to your bot? The **Daily Skill Spotlight** sends a Telegram message each morning highlighting one of your bot's skills — what it does, what it can help with, and example prompts to try. It rotates through all skills with no repeats until the full cycle completes.

To enable it, add a daily cron job:

```bash
crontab -e
# Add this line (adjust the time to your preference):
30 7 * * * ~/copylobsta/agents/main/skills/copylobsta/run_spotlight.sh
```

Requires `OPENCLAW_TELEGRAM_BOT_TOKEN` and `OPENCLAW_TELEGRAM_CHAT_ID` in your `~/.openclaw/.env`.

## Security

A daily **prompt injection scan** runs at 3 AM (set up automatically by `install.sh`). It checks for injection keywords, hidden unicode characters, embedded tokens, and unexpected file modifications — then reports findings to your Telegram chat.

You can run it manually anytime:

```bash
bash ~/copylobsta/scripts/injection_scan.sh
```

## Customizing Your Bot

### Personality

Edit [SOUL.md](SOUL.md) to define your bot's personality, tone, and values. This is the most important file — it shapes every interaction.

### User Profile

Edit [USER.md](USER.md) to tell your bot about yourself — interests, goals, communication preferences. The bot uses this to personalize responses.

### Identity

Edit [IDENTITY.md](IDENTITY.md) to set your bot's name and basic identity.

## Installing Community Skills

Browse and install skills from ClawHub:

```bash
cd ~/copylobsta/agents/main/skills
npx clawhub@latest install author/skill-slug --workdir .
```

## Publishing Skills

Share your custom skills with the community:

```bash
cd ~/copylobsta/agents/main/skills/your-skill
npx clawhub@latest login
npx clawhub@latest publish . --slug your-skill --name "Your Skill" --version 1.0.0
```

## Architecture

CopyLobsta is a **config + skills repo**, not a standalone application. The [OpenClaw](https://www.npmjs.com/package/openclaw) NPM package runs as a gateway service and handles:

- Telegram bot integration
- Model provider routing (Anthropic, OpenAI, Google)
- Skill discovery and loading
- Conversation memory
- Session management

This repo provides the configuration, personality docs, and skills that make the bot yours.

## Estimated Costs

| Component | Monthly Cost |
|-----------|-------------|
| AWS EC2 (t3.medium) | ~$37 |
| AI API usage (moderate) | $10–30 |
| **Total** | **~$47–67** |

A $50/month AWS budget alert is included in the CloudFormation template.

## Manual AWS Setup

If you're not using CopyLobsta's automated deployment:

```bash
# Deploy the CloudFormation stack
aws cloudformation create-stack \
  --stack-name my-openclaw \
  --template-body file://infra/openclaw-runtime.yaml \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=BudgetAlertEmail,ParameterValue=you@example.com

# Connect via SSM (no SSH needed)
aws ssm start-session --target <instance-id>
```

## License

MIT — see [LICENSE](LICENSE).

Built by Sadie Hertzig for the OpenClaw community.
