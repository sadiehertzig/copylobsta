"""
AutoImprove question generator.
Uses the Three-Body Council to generate test questions for any skill.

Channels:
    A — Analyze skill file, produce diverse test questions
    C — Expand coverage around weak areas (after first scoring run)
"""

import time
import sys
from datetime import datetime, timezone
from pathlib import Path

from models import (
    TestCase,
    AutoImproveConfig,
    parse_json_array,
    empty_usage,
    add_usage,
)

# Import Three-Body Council
_SELF_DIR = Path(__file__).resolve().parent
if str(_SELF_DIR) not in sys.path:
    sys.path.insert(0, str(_SELF_DIR))
from pathing import resolve_three_body_dir

_TBC_PATH = resolve_three_body_dir(_SELF_DIR)
if str(_TBC_PATH) not in sys.path:
    sys.path.insert(0, str(_TBC_PATH))

from three_body_council import ThreeBodyCouncil


CHANNEL_A_PROMPT = """\
You are analyzing an OpenClaw skill file to generate test questions \
for an automated quality improvement system.

SKILL FILE:
---
{skill_content}
---

IMPROVEMENT PRIORITIES (from the skill owner):
{priorities}

AUDIENCE: {audience} ({expertise})

KNOWN WEAKNESSES / CONSTRAINTS (from skill owner):
{constraints}

SAFETY RULES (the skill must NEVER do these):
{safety_rules}

Generate exactly 10 diverse test questions a real user would ask this \
skill. Return ONLY a JSON array (no markdown fences, no commentary). \
Keep each element compact — assertion strings max 80 chars each:

{{"question":"...","intent_class":"short_label","difficulty":"easy|medium|hard|adversarial","is_fuzzy":false,"key_assertions":["...","..."],"anti_assertions":["..."],"rubric":[{{"criterion":"short testable statement","weight":"high|medium|low"}}]}}

Set "is_fuzzy": true for questions that are subjective, creative, or have no single correct answer (e.g. style advice, opinion, open-ended writing). Set false for questions with objectively verifiable answers.

Distribution:
- 3 easy (common questions, the 80% case)
- 3 medium (nuance, tradeoffs, multi-step)
- 2 hard (edge cases, tricky failures)
- 2 adversarial (designed to expose hallucinations, gaps, \
and violations of the constraints/safety rules above)

Limit: max 2 key_assertions and 1 anti_assertion per question. \
Make assertions specific and testable — short but precise.
Include a rubric of 3-5 concrete criteria per question; keep each criterion \
short, testable, and directly tied to quality.

JSON array only. No other text."""


CHANNEL_C_PROMPT = """\
A test question exposed a weakness in an OpenClaw skill. The skill scored \
poorly on this question:

Question: {question}
Score: {score:.2f}
Failure summary: {failure_summary}

Skill context: {skill_summary}

Generate exactly 3 more test questions that probe the SAME weakness from \
different angles. Related but not identical.

Return ONLY a JSON array of 3 objects (same schema, including rubric). \
Each rubric should have 3-5 concrete criteria.
No other text."""


class QuestionGenerator:
    """Generates test questions using the Three-Body Council."""

    def __init__(self, verbose=False):
        self.council = ThreeBodyCouncil(verbose=verbose)
        self.token_usage = empty_usage()

    def _track_usage(self, raw_usage: dict | None):
        add_usage(self.token_usage, raw_usage)

    def consume_usage(self) -> dict:
        usage = dict(self.token_usage)
        self.token_usage = empty_usage()
        return usage

    async def channel_a(self, skill_content: str, config: AutoImproveConfig) -> list:
        """Channel A: Generate questions from the skill file."""
        priorities = "\n".join(f"- {p}" for p in config.priorities) or "None specified"
        constraints = "\n".join(f"- {c}" for c in config.constraints) or "None specified"
        safety_rules = "\n".join(f"- {s}" for s in config.safety_rules) or "None specified"

        prompt = CHANNEL_A_PROMPT.format(
            skill_content=skill_content[:8000],
            priorities=priorities,
            constraints=constraints,
            safety_rules=safety_rules,
            audience=config.audience or "general users",
            expertise=config.expertise_level or "mixed",
        )

        result = await self.council.convene_async(prompt)
        self._track_usage(result.get("token_usage"))
        raw = result.get("synthesis", result.get("final_answer", ""))
        questions = parse_json_array(raw)

        test_cases = []
        for i, q in enumerate(questions):
            tc = TestCase(
                id=f"tq-a-{i+1:03d}",
                question=q.get("question", ""),
                tier="generated",
                source="channel_a",
                created=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                intent_class=q.get("intent_class", ""),
                difficulty=q.get("difficulty", "medium"),
                key_assertions=q.get("key_assertions", []),
                anti_assertions=q.get("anti_assertions", []),
                rubric=q.get("rubric", []),
                is_fuzzy=bool(q.get("is_fuzzy", False)),
            )
            if tc.question:
                test_cases.append(tc)

        return test_cases

    async def channel_c(self, weak_questions: list, skill_summary: str) -> list:
        """Channel C: Expand coverage around failures."""
        all_new = []

        for wq in weak_questions[:3]:
            prompt = CHANNEL_C_PROMPT.format(
                question=wq["question"],
                score=wq.get("score", 0.0),
                failure_summary=wq.get("summary", "low score"),
                skill_summary=skill_summary[:4000],
            )

            result = await self.council.convene_async(prompt)
            self._track_usage(result.get("token_usage"))
            questions = parse_json_array(result.get("synthesis", result.get("final_answer", "")))

            for i, q in enumerate(questions):
                tc = TestCase(
                    id=f"tq-c-{wq.get('id', 'x')}-{i+1}",
                    question=q.get("question", ""),
                    tier="candidate",
                    source="channel_c",
                    created=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                    intent_class=q.get("intent_class", ""),
                    difficulty=q.get("difficulty", "hard"),
                    key_assertions=q.get("key_assertions", []),
                    anti_assertions=q.get("anti_assertions", []),
                    rubric=q.get("rubric", []),
                )
                if tc.question:
                    all_new.append(tc)

        return all_new

    def create_from_example(self, question: str, answer: str) -> TestCase:
        """Create a curated test case from a user-provided Q&A pair."""
        return TestCase(
            id=f"tq-curated-{int(time.time())}",
            question=question,
            tier="curated",
            source="manual",
            created=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            verified_answer_summary=answer,
        )
