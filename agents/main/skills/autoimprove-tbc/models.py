"""
AutoImprove data models.
No external dependencies — pure Python dataclasses.
"""

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
import json

from security import atomic_write_json, atomic_write_text, clamp_int


# ─────────────────────────────────────────────────────────
# Shared constants
# ─────────────────────────────────────────────────────────

DEFAULT_MODEL = "claude-sonnet-4-6"
MIN_MAX_ITERATIONS = 1
MAX_MAX_ITERATIONS = 50
MIN_TOKEN_BUDGET = 50_000
MAX_TOKEN_BUDGET = 5_000_000


# ─────────────────────────────────────────────────────────
# JSON parsing helpers (LLM output often has markdown fences)
# ─────────────────────────────────────────────────────────

def _strip_markdown_fences(text: str) -> str:
    """Strip markdown code fences and optional 'json' language tag.

    Handles leading text before the fence, e.g.:
        Here are the questions:
        ```json
        [...]
        ```
    """
    text = text.strip()
    # If the fence isn't at the start, find the first ``` and discard everything before it
    if "```" in text and not text.startswith("```"):
        fence_start = text.find("```")
        text = text[fence_start:]
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    text = text.strip()
    if text.startswith("json"):
        text = text[4:].strip()
    return text


def parse_json_obj(text: str) -> dict | None:
    """Extract a strict JSON object from model output. Returns dict or None."""
    text = _strip_markdown_fences(text)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_json_array(text: str) -> list:
    """Extract a JSON array from model output. Returns list or []."""
    text = _strip_markdown_fences(text)
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass
    start = text.find("[")
    end = text.rfind("]") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            pass
    return []


# ─────────────────────────────────────────────────────────
# Token usage helpers
# ─────────────────────────────────────────────────────────

def _coerce_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def empty_usage() -> dict:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "calls": 0,
    }


def normalize_usage(raw_usage: dict | None) -> dict:
    if not isinstance(raw_usage, dict):
        return empty_usage()
    inp = _coerce_int(raw_usage.get("input_tokens"))
    out = _coerce_int(raw_usage.get("output_tokens"))
    total = _coerce_int(raw_usage.get("total_tokens"))
    calls = _coerce_int(raw_usage.get("calls"))
    if total <= 0:
        total = inp + out
    return {
        "input_tokens": max(0, inp),
        "output_tokens": max(0, out),
        "total_tokens": max(0, total),
        "calls": max(0, calls),
    }


def add_usage(counter: dict, raw_usage: dict | None, calls_if_missing: bool = True) -> dict:
    usage = normalize_usage(raw_usage)
    if calls_if_missing and usage["calls"] == 0 and usage["total_tokens"] > 0:
        usage["calls"] = 1
    counter["input_tokens"] += usage["input_tokens"]
    counter["output_tokens"] += usage["output_tokens"]
    counter["total_tokens"] += usage["total_tokens"]
    counter["calls"] += usage["calls"]
    return counter


# ─────────────────────────────────────────────────────────
# TestCase — a question used to evaluate a skill
# ─────────────────────────────────────────────────────────

@dataclass
class TestCase:
    """A single test question with assertions for grading."""
    id: str
    question: str
    tier: str = "generated"                # curated | generated | candidate
    source: str = "channel_a"              # channel_a | channel_b | channel_c | manual
    created: str = ""
    intent_class: str = ""
    difficulty: str = "medium"             # easy | medium | hard | adversarial
    key_assertions: list = field(default_factory=list)
    anti_assertions: list = field(default_factory=list)
    rubric: list = field(default_factory=list)  # [{"criterion": "...", "weight": "high|medium|low"}]
    conversation_history: list = field(default_factory=list)  # [{"role": "user"|"assistant", "content": "..."}]
    verified_answer_summary: str = ""
    last_score: float = 0.0
    score_history: list = field(default_factory=list)
    is_fuzzy: bool = False  # Auto-detected or set by question_gen

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        valid_keys = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in d.items() if k in valid_keys})


# ─────────────────────────────────────────────────────────
# Verdict — grading result from the Three-Body Council
# ─────────────────────────────────────────────────────────

@dataclass
class Verdict:
    """Structured grading result for one test question."""
    test_id: str
    grading_tier: str = "full_panel"       # full_panel | quick | prefilter_fail
    assertion_results: list = field(default_factory=list)
    anti_assertion_results: list = field(default_factory=list)
    scores: dict = field(default_factory=dict)
    composite_score: float = 0.0
    flags: list = field(default_factory=list)
    confidence: str = "MEDIUM"
    summary: str = ""
    transcript_path: str = ""

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        valid_keys = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in d.items() if k in valid_keys})

    @property
    def has_safety_flag(self):
        return any("safety" in str(f).lower() for f in self.flags)


# ─────────────────────────────────────────────────────────
# Config — parsed from program.md
# ─────────────────────────────────────────────────────────

@dataclass
class AutoImproveConfig:
    """Configuration for an AutoImprove target, generated from the interview."""
    target_skill: str = ""
    skill_path: str = ""
    repo_path: str = ""
    mode: str = "agent_simulation"         # agent_simulation | tool_simulation | direct_invocation
    priorities: list = field(default_factory=list)
    constraints: list = field(default_factory=list)
    audience: str = ""
    expertise_level: str = ""
    style_notes: str = ""
    safety_rules: list = field(default_factory=list)
    example_pairs: list = field(default_factory=list)

    # grading
    grading_tier: str = "tiered"           # tiered | full_panel | quick_only
    regression_threshold: float = 0.15
    min_improvement: float = 0.01
    min_test_questions: int = 10

    # budget
    max_iterations: int = 15
    token_budget: int = 1_000_000

    def enforce_bounds(self):
        self.max_iterations = clamp_int(self.max_iterations, MIN_MAX_ITERATIONS, MAX_MAX_ITERATIONS)
        if self.token_budget <= 0:
            self.token_budget = 0
        else:
            self.token_budget = clamp_int(self.token_budget, MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET)

    def to_program_md(self) -> str:
        """Serialize config to program.md format."""
        lines = [
            f"# AutoImprove \u2014 {self.target_skill} Program",
            "",
            "## Target",
            f"skill_path: {self.skill_path}",
            f"repo_path: {self.repo_path}",
            f"mode: {self.mode}",
            "",
            "## Audience",
            f"primary_users: {self.audience}",
            f"expertise_level: {self.expertise_level}",
            f"style: {self.style_notes}",
            "",
            "## Priorities",
        ]
        for i, p in enumerate(self.priorities, 1):
            lines.append(f"{i}. {p}")

        lines += ["", "## Constraints"]
        for c in self.constraints:
            lines.append(f"- {c}")

        lines += ["", "## Safety Rules"]
        for s in self.safety_rules:
            lines.append(f"- {s}")

        if self.example_pairs:
            lines += ["", "## Example Pairs"]
            for ep in self.example_pairs:
                lines.append(f"- Q: {ep.get('question', '')}")
                lines.append(f"  A: {ep.get('answer', '')}")

        lines += [
            "",
            "## Grading",
            f"grading_tier: {self.grading_tier}",
            f"regression_threshold: {self.regression_threshold}",
            f"min_improvement: {self.min_improvement}",
            f"min_test_questions: {self.min_test_questions}",
            "",
            "## Budget",
            f"max_iterations: {self.max_iterations}",
            f"token_budget: {self.token_budget}",
        ]
        return "\n".join(lines)

    def save(self, path: str):
        self.enforce_bounds()
        atomic_write_text(Path(path), self.to_program_md())

    @classmethod
    def load(cls, path: str) -> "AutoImproveConfig":
        """Parse a program.md back into config."""
        config = cls()
        text = Path(path).read_text()
        current_section = None
        legacy_section = None

        for line in text.split("\n"):
            stripped = line.strip()

            if not stripped:
                legacy_section = None

            # Track sections
            if stripped.startswith("## "):
                current_section = stripped[3:].strip().lower()
                legacy_section = None
                continue

            # Key-value pairs
            if ":" in stripped and not stripped.startswith("-") and not stripped.startswith("#"):
                key, _, val = stripped.partition(":")
                key = key.strip().lower()
                val = val.strip()

                if key == "skill_path":
                    config.skill_path = val
                elif key == "repo_path":
                    config.repo_path = val
                elif key == "mode":
                    config.mode = val
                elif key == "target_skill":
                    config.target_skill = val
                elif key == "primary_users":
                    config.audience = val
                elif key == "audience":
                    config.audience = val
                elif key == "expertise_level":
                    config.expertise_level = val
                elif key == "style":
                    config.style_notes = val
                elif key == "style_notes":
                    config.style_notes = val
                elif key == "grading_tier":
                    config.grading_tier = val
                elif key == "regression_threshold":
                    try: config.regression_threshold = float(val)
                    except ValueError: pass
                elif key == "min_improvement":
                    try: config.min_improvement = float(val)
                    except ValueError: pass
                elif key == "min_test_questions":
                    try: config.min_test_questions = int(val)
                    except ValueError: pass
                elif key == "max_iterations":
                    try: config.max_iterations = int(val)
                    except ValueError: pass
                elif key == "token_budget":
                    try: config.token_budget = int(val)
                    except ValueError: pass
                elif key == "priorities" and not val:
                    legacy_section = "priorities"
                elif key == "constraints" and not val:
                    legacy_section = "constraints"
                elif key in {"safety_rules", "safety rules"} and not val:
                    legacy_section = "safety rules"

            # List items
            active_section = current_section or legacy_section
            if stripped.startswith("- ") and active_section:
                item = stripped[2:].strip()
                if active_section == "constraints":
                    config.constraints.append(item)
                elif active_section == "safety rules":
                    config.safety_rules.append(item)
                elif active_section == "example pairs" and item.startswith("Q: "):
                    config.example_pairs.append({"question": item[3:], "answer": ""})
                elif active_section == "priorities":
                    config.priorities.append(item)

            # Example pair answer lines (indented "A: ...")
            if stripped.startswith("A: ") and current_section == "example pairs":
                if config.example_pairs:
                    config.example_pairs[-1]["answer"] = stripped[3:]

            # Numbered items (priorities)
            if current_section == "priorities" and stripped and stripped[0].isdigit():
                item = stripped.lstrip("0123456789.) ").strip()
                if item:
                    config.priorities.append(item)

        # Extract name from header only if not set explicitly in key-values.
        if not config.target_skill:
            for line in text.split("\n"):
                if line.startswith("# AutoImprove"):
                    config.target_skill = (
                        line.replace("# AutoImprove \u2014", "")
                        .replace("# AutoImprove -", "")
                        .replace("Program", "")
                        .strip()
                    )
                    break

        config.enforce_bounds()
        return config


# ─────────────────────────────────────────────────────────
# Test Bank persistence
# ─────────────────────────────────────────────────────────

def load_test_bank(path: str) -> list:
    p = Path(path)
    if not p.exists():
        return []
    data = json.loads(p.read_text())
    return [TestCase.from_dict(d) for d in data]


def save_test_bank(bank: list, path: str):
    atomic_write_json(Path(path), [tc.to_dict() for tc in bank])


# ─────────────────────────────────────────────────────────
# Results Logger
# ─────────────────────────────────────────────────────────

class ResultsLogger:
    """Append-only TSV log of improvement iterations."""

    HEADER = (
        "timestamp\tedit_description\taggregate_before\t"
        "aggregate_after\tkept\treason\tworst_question\tworst_score\n"
    )

    def __init__(self, path: str):
        self.path = Path(path)
        if not self.path.exists():
            atomic_write_text(self.path, self.HEADER)

    def log(self, description, agg_before, agg_after, kept, reason,
            worst_tid="", worst_score=0.0):
        line = (
            f"{datetime.now(timezone.utc).isoformat()}\t{description}\t"
            f"{agg_before:.4f}\t{agg_after:.4f}\t{kept}\t{reason}\t"
            f"{worst_tid}\t{worst_score:.4f}\n"
        )
        with open(self.path, "a") as f:
            f.write(line)

    def tail(self, n=10) -> str:
        if not self.path.exists():
            return ""
        lines = self.path.read_text().strip().split("\n")
        return "\n".join(lines[-n:])

    def parse_entries(self) -> list:
        if not self.path.exists():
            return []
        lines = self.path.read_text().strip().split("\n")
        if len(lines) < 2:
            return []
        header = lines[0].split("\t")
        entries = []
        for line in lines[1:]:
            parts = line.split("\t")
            if len(parts) >= len(header):
                entries.append(dict(zip(header, parts)))
        return entries
