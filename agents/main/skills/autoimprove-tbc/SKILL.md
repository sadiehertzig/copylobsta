---
name: autoimprove-tbc
description: >
  Three-Body Council self-improvement loop with fuzzy-task auto-detection.
  Trigger when the user says "tbc improve", "autoimprove-tbc",
  "autoimprove tbc", "fuzzy improve", "deep improve",
  "three-body improve", "autoimprove-tbc status",
  "autoimprove-tbc results", "autoimprove-tbc report",
  "what did autoimprove-tbc do", or any request to improve quality of
  an existing skill using multi-model grading. Also trigger for
  "add test question" or "show test bank".
metadata:
  version: "2.0.0"
  author: "Sadie Hertzig / OpenClaw Community"
  homepage: "https://github.com/sadiehertzig/CopyLobsta"
  tags: ["self-improvement", "testing", "grading", "quality", "automation", "three-body-council", "fuzzy"]
  dependencies: ["three-body-council"]
  based_on: "autoimprove by ClawHub community (https://clawhub.ai/skills/autoimprove)"
---

# AutoImprove-TBC — Three-Body Council Self-Improvement Loop

Makes any OpenClaw skill smarter overnight using the Three-Body Council
as an automated grading panel, with fuzzy-task auto-detection for
subjective and creative tasks.

Based on the [autoimprove](https://clawhub.ai/skills/autoimprove) skill
from ClawHub. Extended with Three-Body Council multi-model grading and
automatic escalation for fuzzy/subjective tasks.

## How It Works

1. **Interview** — The bot asks what "better" means for the target skill
2. **Generate** — Three-Body Council creates test questions automatically
3. **Baseline** — Score the skill as-is to establish a starting point
4. **Improve** — Nightly loop: propose edits -> grade -> keep or revert
5. **Report** — Morning summary of what changed overnight

### Fuzzy-Task Auto-Detection

When test questions are subjective or creative (no single right answer),
autoimprove-tbc automatically escalates to the full Three-Body Council
panel instead of quick single-model grading. Detection checks:

- Explicit `is_fuzzy` flag on test cases
- Soft assertions containing subjective keywords ("appropriate", "engaging", etc.)
- Rubric criteria with subjective language
- Missing verified answers (no ground truth)
- Score plateau detection (quick grader uncertainty)

## Commands

- `tbc improve [skill name]` — start the interview flow
- `autoimprove-tbc status` — show state of active improvement programs
- `autoimprove-tbc results` — morning report for most recent run
- `autoimprove-tbc pause/resume [skill]` — control nightly runs
- `add test question for [skill] :: [question] || [ideal answer optional]` — manually add a curated test case
- `show test bank for [skill]` — display test questions and scores

## Dependencies

- three-body-council skill (installed and working)
- httpx (`pip install httpx`)
- git (for ratchet mechanism)
- At least 2 of 3 API keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
- Optional improver failover override: `AUTOIMPROVE_IMPROVER_MODEL_CHAIN`
