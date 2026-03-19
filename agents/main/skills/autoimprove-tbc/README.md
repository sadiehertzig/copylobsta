# AutoImprove-TBC

A [Karpathy](https://github.com/karpathy)-inspired self-improving skill loop for [OpenClaw](https://github.com/openclaw) that makes any skill better overnight using the [Three-Body Council](../three-body-council/) as an automated grading panel, with automatic escalation for fuzzy/subjective tasks.

Built by Sadie Hertzig. Inspired by Andrej Karpathy's autoresearch concept — Mr Karpathy is not responsible for what happened next. lol

## Credits

AutoImprove-TBC builds on the [autoimprove](https://clawhub.ai/skills/autoimprove) skill from ClawHub. The core improvement loop pattern comes from the ClawHub community. This fork adds Three-Body Council multi-model grading and fuzzy-task auto-detection for tasks where quick single-model grading isn't sufficient.

## What it does

AutoImprove-TBC takes a skill you've already built and systematically makes it better:

1. **Interview** — Asks you what "better" means for this skill (audience, ideal answers, things to avoid)
2. **Generate** — Creates a test bank of questions across difficulty levels (easy, medium, hard, adversarial)
3. **Baseline** — Scores the skill as-is to establish a starting point
4. **Improve** — Proposes edits, grades the result, keeps improvements, reverts regressions
5. **Report** — Sends you a summary of what changed

The ratchet mechanism ensures the skill never gets worse — every proposed edit is scored against the full test bank, and reverted if quality drops on any dimension.

## Fuzzy-Task Auto-Detection

For subjective or creative tasks where there's no single right answer, autoimprove-tbc automatically escalates to the full Three-Body Council panel (3 models x 3 rounds) instead of quick single-model grading. This ensures that tasks like "write an engaging introduction" or "provide helpful advice" get the multi-perspective evaluation they need.

Detection triggers:
- Test cases explicitly marked `is_fuzzy: true`
- Assertions containing subjective keywords ("appropriate", "helpful", "engaging", "creative", etc.)
- Rubric criteria with subjective language
- Test cases with no verified answer summary (no ground truth)
- Score plateau detection: when scores oscillate in a narrow band, indicating quick grader uncertainty

## How the ratchet works

Every edit must pass four rules before it sticks:

1. **Aggregate score must improve** — overall weighted score goes up
2. **Curated questions can't regress** — hand-picked test cases are protected
3. **No new safety flags** — safety score never drops
4. **Minimum improvement threshold** — changes must be meaningful, not noise

If an edit fails any rule, it's reverted and the skill stays at its previous best.

## Commands

| Command | What it does |
|---------|-------------|
| `tbc improve [skill]` | Start the interview flow for a skill |
| `autoimprove-tbc status` | Show state of active improvement programs |
| `autoimprove-tbc results` | Morning report for the most recent run |
| `autoimprove-tbc pause/resume [skill]` | Control nightly runs |
| `add test question for [skill] :: [question] \|\| [ideal answer optional]` | Manually add a curated test case |
| `show test bank for [skill]` | Display test questions and scores |

## Setup

### Requirements

- Python 3.10+
- `httpx` (`pip install httpx`) — used by AutoImprove-TBC for async API calls
- `requests` (`pip install requests`) — used by Three-Body Council for sync API calls
- `git` (for the ratchet mechanism)
- [Three-Body Council](../three-body-council/) skill installed (required — AutoImprove-TBC uses it for grading)
- At least 2 of 3 API keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`

### Optional: Telegram Approval

AutoImprove-TBC can send proposed changes to Telegram for manual approval before committing. Set your bot token in `~/.openclaw/.env`:

```
OPENCLAW_TELEGRAM_BOT_TOKEN=YOUR_DEFAULT_BOT_TOKEN   # ~46 chars
```

The destination chat ID is auto-detected from your active Telegram session — whoever is chatting with the OpenClaw instance gets the notifications. To override, set `OPENCLAW_TELEGRAM_OWNER_CHAT_ID` in your env.

Without Telegram configured, AutoImprove-TBC runs fully autonomously (ratchet still prevents regressions).

### Install

AutoImprove-TBC is included in [CopyLobsta](https://github.com/sadiehertzig/CopyLobsta). For standalone use, install the Three-Body Council dependency:

```bash
clawhub install three-body-council
pip install httpx requests
```

> **Note:** For the standard autoimprove loop without Three-Body Council grading, use the community [autoimprove](https://clawhub.ai/skills/autoimprove) skill from ClawHub instead.

## Token usage tracking

AutoImprove-TBC tracks every API call and persists cumulative token usage to `token_usage.json` per target skill. The report includes a breakdown by component (runner, grader, improver, question_gen) and by model (Claude, GPT, Gemini).

AutoImprove-TBC enforces a **token budget** (default: 1,000,000 tokens, ~$15-75 depending on input/output mix). When cumulative usage hits the budget, the current loop and sweep halt gracefully. You can adjust this in your `program.md`:

```
token_budget: 2000000
```

Set `token_budget: 0` to disable the limit entirely (not recommended for unattended runs).

Depending on the size of your test bank and grading tier, costs per iteration vary:

| Grading tier | Approximate cost per question |
|-------------|------------------------------|
| `quick_only` | ~$0.02 (single Sonnet call) |
| `tiered` | ~$0.02-0.20 (quick first, escalates ambiguous) |
| `full_panel` | ~$0.20 (full Three-Body Council, 3 models x 3 rounds) |

A typical 10-question test bank with `tiered` grading runs **~$0.50-2 per iteration**. A full sweep (10 rounds x 5 iterations) could cost **$25-100** depending on convergence speed. Fuzzy-task auto-detection may increase costs slightly since more questions get escalated to `full_panel`.

### Controlling costs

- **`token_budget`** in your program.md — hard cap on total tokens consumed (default: 1,000,000). The loop stops when this is hit.
- **`max_iterations`** in your program.md — caps the number of edit-score cycles per run (default: 15)
- **`grading_tier: quick_only`** — use single-model grading during development, switch to `tiered` or `full_panel` for final passes
- **Smaller test banks** — start with 10 questions; Channel C will expand coverage where needed
- **Monitor `token_usage.json`** — check cumulative spend between runs and adjust strategy
- **`autoimprove-tbc pause [skill]`** — stop nightly runs if costs are climbing faster than scores

The usage report at the end of each run shows exactly where tokens went, so you can spot if one component (usually the grader) is dominating spend and adjust accordingly.

## Architecture

```
autoimprove.py   — Main orchestrator and CLI
interview.py     — Onboarding conversation (6-step state machine)
question_gen.py  — Test bank generation (Channel A: diverse, Channel C: gap-filling)
runner.py        — Executes skill against test questions
grader.py        — Tiered evaluation via Three-Body Council + fuzzy auto-detection
scorer.py        — Weighted scoring and ratchet logic
improver.py      — Proposes and applies SKILL.md edits
notify.py        — Telegram approval flow
models.py        — Data models (TestCase, Verdict, Config, ResultsLogger)
```

## Improver Model Failover

The `improver.py` agent now supports automatic Anthropic model failover:

- Default chain from `DEFAULT_MODEL` in `models.py`
- Built-in SOTA-1 fallback (for example `claude-opus-4-6 -> claude-sonnet-4-6`)
- For the current default (`claude-sonnet-4-6`), fallback is `claude-3-5-haiku-latest`

Optional env overrides:

- `AUTOIMPROVE_IMPROVER_MODEL_CHAIN` (comma-separated full chain)
- `AUTOIMPROVE_IMPROVER_MODEL` (primary)
- `AUTOIMPROVE_IMPROVER_FALLBACK_MODEL` (single fallback)

## License

MIT
