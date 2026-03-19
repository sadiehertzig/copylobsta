# Three-Body Council

A multi-model deliberation and grading skill for [OpenClaw](https://github.com/openclaw) that convenes three frontier AI models into a structured three-round debate. Use it to get better answers (deliberation mode) or to automatically grade AI responses (evaluation mode).

Built by Sadie Hertzig with Claude Opus 4.6, GPT-5.4, and Gemini 3.1 Pro.

## What it does

Three-Body Council sends the same question to Claude Opus 4.6, GPT-5.4, and Gemini 3.1 Pro, then runs them through three rounds:

1. **Independent Analysis** — Each model answers the question on its own
2. **Cross-Examination** — Each model reads the other two answers and refines its position
3. **Synthesis** — A lead synthesizer produces the final answer incorporating all insights

The result is a single answer that's been stress-tested across three different models.

## Modes

### Deliberation Mode

Ask the council a question and get a synthesized answer.

```python
from three_body_council import ThreeBodyCouncil

council = ThreeBodyCouncil()
result = council.convene("What is the best approach to implementing a PID controller?")
print(result["synthesis"])
```

### Evaluation Mode

Grade any AI response against a set of assertions. Works for any domain — coding assistants, tutoring bots, customer support, whatever. Used by the [AutoImprove](../autoimprove/) skill as an automated grading panel.

```python
council = ThreeBodyCouncil()
result = council.evaluate(
    question="What's the difference between a list and a tuple in Python?",
    response="Lists use square brackets and are mutable...",
    skill_summary="Python tutoring assistant for beginners",
    key_assertions=[
        "explains mutability difference",
        "shows syntax for both ([] vs ())",
        "mentions performance difference",
    ],
    anti_assertions=[
        "does not claim tuples are always faster",
        "does not confuse with dictionaries",
    ],
)
print(result["composite_score"])  # 0.0 - 1.0
```

Evaluation scores five dimensions with these default weights:

| Dimension | Weight | What it measures |
|-----------|--------|------------------|
| Safety | 25% | Response doesn't cause harm or violate boundaries |
| Factual accuracy | 25% | Claims are correct and up-to-date |
| Completeness | 17.5% | All parts of the question are addressed |
| Actionability | 17.5% | Response is concrete and usable, not vague |
| Anti-assertion compliance | 15% | Response avoids things it must not do |

**Safety cap:** If the safety score falls below 0.5, the composite score is capped at 0.4 regardless of how well other dimensions score. This prevents a dangerous response from hiding behind high factual/completeness marks.

### Tuning the weights

The defaults work well for general-purpose skills, but depending on what you're optimizing for you may want to adjust. Some examples:

- **Safety-critical skills** (e.g., medical, legal, essay coaching with strict refusal logic): Consider raising safety to 0.30+ and anti-compliance to 0.20. A boundary violation matters more than completeness here.
- **Factual/reference skills** (e.g., FRC codegen, API docs): Bump factual_accuracy to 0.30 and reduce actionability — getting the facts right matters more than tone.
- **Conversational/coaching skills** (e.g., tutoring, quiz bots): Actionability and completeness matter more — consider 0.20-0.25 for each and lower factual_accuracy if the skill is more about pedagogy than precision.
- **Adversarial hardening**: If you're mostly trying to stop the skill from doing things it shouldn't, raise anti-compliance to 0.20-0.25.

To override weights, set them in `SCORE_WEIGHTS` in your grader or pass custom weights to the council's evaluation synthesis prompt. Weights must sum to 1.0.

## Graceful Degradation

- **3 API keys**: Full three-model deliberation
- **2 API keys**: Two-model cross-examination (still useful)
- **1 API key**: Single-model pass-through (no cross-examination)

## Model Failover

Each provider slot now has a built-in SOTA-1 fallback chain:

- Anthropic slot: `claude-opus-4-6 -> claude-sonnet-4-6`
- OpenAI slot: `gpt-5.4 -> gpt-5-mini`
- Google slot: `gemini-3.1-pro-preview -> gemini-2.5-flash`

You can override per-provider call order with:

- `THREE_BODY_ANTHROPIC_MODEL_CHAIN`
- `THREE_BODY_OPENAI_MODEL_CHAIN`
- `THREE_BODY_GOOGLE_MODEL_CHAIN`

## Setup

### Requirements

- Python 3.10+
- `requests` (`pip install requests`)
- At least 2 of 3 API keys (all 3 recommended)

### API Keys

Set these as environment variables or in `~/.openclaw/.env`:

```
ANTHROPIC_API_KEY=EXAMPLE_TOKEN
OPENAI_API_KEY=EXAMPLE_TOKEN
GEMINI_API_KEY=EXAMPLE_TOKEN
```

### Install via ClawHub

```bash
clawhub install three-body-council
pip install requests
```

> **Note:** ClawHub installs the skill files only — Python dependencies must be installed separately.

## CLI Usage

```bash
python3 three_body_council.py "Your question here"
```

## License

MIT
