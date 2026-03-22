# CopyLobsta — OpenClaw Distribution Repo

## Project Structure

```
copylobsta/
  README.md
  LICENSE
  SOUL.md                    — Bot personality (user edits this)
  USER.md                    — User profile (user edits this)
  IDENTITY.md                — Bot name/identity
  AGENTS.md                  — Agent behavior guidelines
  HEARTBEAT.md               — Heartbeat config
  TOOLS.md                   — Tool permissions
  CLAUDE.md                  — This file
  agents/
    main/                    — Primary agent
      SOUL.md, USER.md, IDENTITY.md, AGENTS.md, HEARTBEAT.md, TOOLS.md, MEMORY.md
      skills/                — All skills live here (14 included)
  setup/
    .env.example             — Environment variable template
    openclaw.json.template   — Gateway config template
    install.sh               — Bootstrap script
  infra/
    openclaw-runtime.yaml    — AWS CloudFormation template
```

## Agents

There is one agent: `main`. Its skills are in `agents/main/skills/`.

## Skills

Each skill is a folder inside `agents/main/skills/` containing a `SKILL.md` (and optionally a `README.md`).

Skills follow the OpenClaw/AgentSkills format:
- YAML frontmatter with `name`, `description`, and optional `homepage` and `metadata`
- Markdown body with instructions the agent follows
- Pure prompt-instruction skills preferred — no executable code unless necessary

### Included Skills

| Skill | Type | Notes |
|-------|------|-------|
| quiz-me | Prompt | Adaptive quizzing |
| notes-quiz | Prompt | Quiz from uploaded notes |
| academic-deep-research | Prompt | Rigorous academic research ([kesslerio](https://github.com/kesslerio/academic-deep-research-clawhub-skill)) |
| creative-writing | Prompt | Writing partner |
| code-tutor | Prompt | Hints-first coding tutor |
| college-essay | Prompt | Essay coaching (**see safety rules below**) |
| three-body-council | Python | Multi-model debate |
| autoimprove | Prompt | Autonomous optimization loop for any measurable thing |
| autoimprove-tbc | Python | Three-Body Council self-improvement with fuzzy-task detection |
| self-improving | Prompt | Self-reflection, self-criticism, and tiered memory for permanent learning |
| voice-trivia | Express.js | Voice trivia Mini App (port 3456) |
| copylobsta | TypeScript | Friend onboarding Mini App (port 3457) |
| api-spend-tracker | Python | API cost tracking |
| enable-sharing | Prompt | Enable on-demand CopyLobsta sharing mode (copylobsta-specific) |

### Installing Community Skills

```bash
cd ~/copylobsta/agents/main/skills
npx clawhub@latest install author/skill-slug --workdir .
```

### Creating Custom Skills

1. Create a folder in `agents/main/skills/`
2. Add a `SKILL.md` with YAML frontmatter and instructions
3. Optionally add a `README.md` for documentation
4. Restart OpenClaw to pick up the new skill

### Publishing to ClawHub

```bash
cd agents/main/skills/skill-name
npx clawhub@latest login
npx clawhub@latest publish . --slug skill-name --name "Display Name" --version X.Y.Z --tags latest
```

## Safety Rules

The `college-essay` skill has strict refusal logic:

- **NEVER** weaken the Non-Negotiables or Disallowed Help sections
- **NEVER** add capabilities that generate submission-ready essay text
- The coaching-only boundary must be maintained

## Do Not Commit

- `memory/` directories — conversation history (in `.gitignore`)
- `.openclaw/workspace-state.json` — local state
- API keys, tokens, or secrets of any kind
- `.env` files

## After Making Changes

1. Restart OpenClaw: `systemctl --user restart openclaw-gateway`
2. Push to GitHub: `git add . && git commit -m "description" && git push origin main`
3. If updating a ClawHub-published skill, bump the version and republish
