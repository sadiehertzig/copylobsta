---
name: three-body-council
description: Multi-model deliberation panel that convenes Claude Opus 4.6, GPT-5.4, and Gemini 3.1 Pro for structured three-round debates
metadata:
  version: "1.1.0"
  author: "OpenClaw Community"
  homepage: "https://github.com/sadiehertzig/CopyLobsta"
  tags: ["deliberation", "multi-model", "evaluation", "grading"]
---

# Three-Body Council

A multi-model deliberation skill that convenes three frontier AI models into a structured three-round debate:

1. **Round 1 — Independent Analysis**: Each model analyzes the question independently
2. **Round 2 — Cross-Examination**: Models review each other's analyses and refine their positions
3. **Round 3 — Synthesis**: A lead synthesizer produces the final answer incorporating all insights

## Models

- **Claude Opus 4.6** (Anthropic)
- **GPT-5.4** (OpenAI)
- **Gemini 3.1 Pro** (Google)

Default failover chains:

- Anthropic: `claude-opus-4-6 -> claude-sonnet-4-6`
- OpenAI: `gpt-5.4 -> gpt-5-mini`
- Google: `gemini-3.1-pro-preview -> gemini-2.5-flash`

The council gracefully degrades to 2-model or 1-model mode if some API keys are unavailable.

## Usage

### CLI
```bash
python3 three_body_council.py "What is the best approach to implementing a PID controller?"
```

### Python
```python
from three_body_council import ThreeBodyCouncil

council = ThreeBodyCouncil()
result = council.convene("What is the best approach to X?")
print(result["synthesis"])
```

## Evaluation Mode

The council can also operate as an automated grading panel. Instead of deliberating on a question, it evaluates an AI response against a set of assertions.

### Python Usage

```python
from three_body_council import ThreeBodyCouncil

council = ThreeBodyCouncil()
result = council.evaluate(
    question="How do I configure a TalonFX in Phoenix 6?",
    response="Use com.ctre.phoenix.motorcontrol.can.TalonFX...",  # the response to grade
    skill_summary="FRC robotics help desk for Java WPILib",
    key_assertions=[
        "mentions Phoenix 6 import path: com.ctre.phoenix6.hardware.TalonFX",
        "includes vendordeps update step",
    ],
    anti_assertions=[
        "does not reference Phoenix 5 import as current",
    ],
)
print(result["composite_score"])   # 0.0 - 1.0
print(result["verdict"]["summary"])
```

### Output Structure

- `composite_score`: float 0.0-1.0 (weighted: safety 25%, accuracy 25%, completeness 20%, actionability 20%, anti-compliance 10%)
- `verdict`: full JSON with per-assertion pass/fail, dimensional scores, flags, confidence
- `round1_evals` / `round2_evals`: raw evaluations from each model per round
- `models_participated`: which models contributed
- `elapsed_seconds`: wall time

## Configuration

Set these environment variables (or in `~/.openclaw/.env`):

- `ANTHROPIC_API_KEY` — for Claude Opus 4.6
- `OPENAI_API_KEY` — for GPT-5.4
- `GEMINI_API_KEY` — for Gemini 3.1 Pro
- Optional per-slot override: `THREE_BODY_<PROVIDER>_MODEL_CHAIN` (comma-separated)

Python runtime dependency:

- `requests` (`python3 -m pip install requests`)

At least two keys are recommended for meaningful cross-examination.
