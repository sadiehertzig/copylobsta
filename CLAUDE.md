# CopyLobsta — OpenClaw Distribution Repo

## Project Structure

```
copylobsta/
  README.md
  LICENSE
  CLAUDE.md                  — This file
  agents/
    main/                    — Primary agent
      SOUL.md, USER.md, IDENTITY.md, AGENTS.md, HEARTBEAT.md, TOOLS.md, MEMORY.md
      skills/
        copylobsta/          — CopyLobsta skill source of truth
          server/            — Mini App + onboarding server
          setup-api/         — Temporary instance-side setup API
        enable-sharing/      — Helper skill for on-demand sharing
  setup/
    .env.example             — Environment variable template
    openclaw.json.template   — Gateway config template
    install.sh               — Bootstrap script
  infra/
    openclaw-runtime.yaml    — AWS CloudFormation template
  scripts/
    sync-template-s3.sh      — Syncs the CFN template to S3 with SHA verification
  .github/workflows/
    sync-cfn-template.yml    — Auto-syncs template changes to S3
```

## Agents

There is one agent: `main`. Its skills are in `agents/main/skills/`.

## Source Of Truth

`copylobsta` is now the deployment source of truth for the CopyLobsta skill.

- The CloudFormation bootstrap clones this repo and uses paths inside `agents/main/skills/copylobsta/`.
- Do not point this repo back at `/home/openclaw/clawdia-hertz-openclaw/...` or any other machine-local absolute path.
- If a local development workspace wants to consume the skill from elsewhere, that workspace should symlink to this repo, not the reverse.
- Any change needed by fresh EC2 launches must land here first.

## Skills

This repo is intentionally narrow. The critical shipped skill is `copylobsta`, plus the small `enable-sharing` helper.

`copylobsta` contains executable code and deployment-critical files:
- `server/` — Telegram Mini App backend and static assets
- `setup-api/` — temporary onboarding API started on the launched instance
- `copylobsta.service` — user service template
- `run_spotlight.sh` and `injection_scan.sh` — scheduled helpers

## Deployment Notes

- The launch path depends on `infra/openclaw-runtime.yaml` being synced to S3.
- Template changes should trigger `.github/workflows/sync-cfn-template.yml`.
- The S3 object metadata should match the latest intended deploy commit before testing a fresh launch.
- The bootstrap must only reference paths that exist inside this repo on a clean clone.

## Local Development

- Host-side runtime state should not be treated as source:
  - `node_modules/`
  - `dist/`
  - `data/sessions/`
  - logs and `.env`
- If tests touch session files, make sure live runtime session JSON is not sitting in the tracked repo path.

## Safety Rules

- Never commit secrets, API keys, or `.env` files.
- Never reintroduce absolute symlinks from this repo into another local checkout.
- Treat CloudFormation/bootstrap changes as production-critical; a broken path here breaks every new onboarding launch.

## Do Not Commit

- `.openclaw/workspace-state.json` — local state
- `node_modules/`, `dist/`, logs, runtime session data
- API keys, tokens, or secrets of any kind
- `.env` files

## After Making Changes

1. Restart OpenClaw: `systemctl --user restart openclaw-gateway`
2. If you changed `infra/openclaw-runtime.yaml`, confirm the template sync workflow succeeds
3. Push to GitHub: `git add . && git commit -m "description" && git push origin main`
4. For deploy-path changes, verify the live S3 template metadata points at the expected commit before re-testing `/copylobsta`
