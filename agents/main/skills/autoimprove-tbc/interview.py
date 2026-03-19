"""
AutoImprove interview engine.
Conversational onboarding to extract what "better" means for a skill.

Usage:
    engine = InterviewEngine(skill_name, skill_content, skill_path)
    while not engine.is_complete():
        prompt = engine.get_next_prompt()
        # ... send to user, get response ...
        engine.process_response(user_answer)
    config = engine.build_config()
"""

from models import AutoImproveConfig


class InterviewEngine:
    """State machine for the improvement interview."""

    STEPS = [
        {
            "id": "whats_wrong",
            "prompt": (
                "What's bothering you about this skill right now? Specific "
                "questions it handles badly, general quality issues, complaints "
                "you've heard \u2014 anything."
            ),
        },
        {
            "id": "audience",
            "prompt": (
                "Who's the primary audience? What's their expertise level?"
            ),
        },
        {
            "id": "ideal_answer",
            "prompt": (
                "What does a great answer from this skill look like? Even "
                "better \u2014 paste an example question and the ideal answer "
                "and I'll turn it into a test case."
            ),
        },
        {
            "id": "never_do",
            "prompt": (
                "Any absolute no-go's? Things this skill should never do or say?"
            ),
        },
        {
            "id": "priorities",
            "prompt": (
                "Top 3 things to fix first?"
            ),
        },
        {
            "id": "confirm_program",
            "prompt": None,  # dynamically generated
        },
    ]

    def __init__(self, skill_name: str, skill_content: str, skill_path: str = ""):
        self.skill_name = skill_name
        self.skill_content = skill_content
        self.skill_path = skill_path
        self.step_index = 0
        self.responses = {}
        self.example_pairs = []

    def is_complete(self) -> bool:
        return self.step_index >= len(self.STEPS)

    def get_current_step_id(self) -> str:
        if self.is_complete():
            return "done"
        return self.STEPS[self.step_index]["id"]

    def get_next_prompt(self) -> str:
        """Get the next question the bot should ask."""
        if self.is_complete():
            return ""

        step = self.STEPS[self.step_index]

        if step["id"] == "whats_wrong":
            return (
                f"I've read the **{self.skill_name}** skill "
                f"({len(self.skill_content)} characters). "
                f"It {self._one_line_summary()}.\n\n"
                "What's bothering you about it? Specific failures, "
                "general quality issues, complaints — anything."
            )

        if step["id"] == "confirm_program":
            config = self._build_config_internal()
            return (
                "Here's the improvement program I've put together:\n\n"
                f"```\n{config.to_program_md()}\n```\n\n"
                "Does this capture it? Say **yes** to proceed, or tell me "
                "what to change."
            )

        return step["prompt"].format(
            skill_name=self.skill_name,
            char_count=len(self.skill_content),
            skill_summary=self._one_line_summary(),
        )

    def process_response(self, answer: str) -> str:
        """
        Process the user's answer. Returns the step_id completed.
        Returns 'confirm_program_revision' if user requested changes
        to the program (step does NOT advance — they see the revised
        preview next time get_next_prompt is called).
        """
        if self.is_complete():
            return "done"

        step = self.STEPS[self.step_index]
        self.responses[step["id"]] = answer

        if step["id"] == "ideal_answer":
            self._extract_examples(answer)

        if step["id"] == "confirm_program":
            lower = answer.lower().strip()
            if any(w in lower for w in [
                "yes", "ok", "good", "looks good", "proceed", "go",
                "correct", "perfect", "lgtm", "ship it", "do it"
            ]):
                self.step_index += 1
                return "confirm_program"
            else:
                self.responses["revision_notes"] = answer
                return "confirm_program_revision"

        self.step_index += 1
        return step["id"]

    def build_config(self) -> AutoImproveConfig:
        """Build final config. Call after is_complete() is True."""
        return self._build_config_internal()

    def get_example_pairs(self) -> list:
        """Return any Q&A pairs the user provided during ideal_answer step."""
        return self.example_pairs

    # ── Internals ──

    def _build_config_internal(self) -> AutoImproveConfig:
        # Auto-detect tool skills
        has_tools = (
            "web_search" in self.skill_content
            or "web_fetch" in self.skill_content
        )
        mode = "tool_simulation" if has_tools else "agent_simulation"

        return AutoImproveConfig(
            target_skill=self.skill_name,
            skill_path=self.skill_path,
            mode=mode,
            audience=self.responses.get("audience", ""),
            expertise_level=self._infer_expertise(),
            style_notes=self._infer_style(),
            priorities=self._parse_list(self.responses.get("priorities", "")),
            constraints=self._infer_constraints(),
            safety_rules=self._parse_list(self.responses.get("never_do", "")),
            example_pairs=self.example_pairs,
        )

    def _one_line_summary(self) -> str:
        for line in self.skill_content.split("\n"):
            s = line.strip()
            if s.startswith("description:"):
                desc = s.replace("description:", "").strip().strip(">").strip("'\"").strip()
                if desc:
                    return desc[:150]
        for line in self.skill_content.split("\n"):
            s = line.strip()
            if s and not s.startswith("#") and not s.startswith("---") and not s.startswith("name:"):
                return s[:150]
        return "does various things"

    def _infer_expertise(self) -> str:
        a = self.responses.get("audience", "").lower()
        if any(w in a for w in ["beginner", "student", "new", "learning", "high school", "kids"]):
            return "beginner"
        if any(w in a for w in ["intermediate", "some experience", "familiar"]):
            return "intermediate"
        if any(w in a for w in ["expert", "advanced", "senior", "professional", "engineer"]):
            return "expert"
        return "mixed"

    def _infer_style(self) -> str:
        t = self.responses.get("ideal_answer", "").lower()
        if any(w in t for w in ["concise", "short", "brief"]):
            return "concise and direct"
        if any(w in t for w in ["detailed", "thorough", "comprehensive"]):
            return "detailed and thorough"
        if any(w in t for w in ["code first", "show code"]):
            return "code-first \u2014 show the solution before the explanation"
        return "clear explanation with concrete examples"

    def _infer_constraints(self) -> list:
        constraints = []
        wrong = self.responses.get("whats_wrong", "").lower()
        if any(w in wrong for w in ["hallucinate", "make up", "fake", "invent"]):
            constraints.append("Never hallucinate API methods, class names, or function signatures")
        if any(w in wrong for w in ["outdated", "old version", "deprecated", "wrong version"]):
            constraints.append("Always reference current library versions, not deprecated ones")
        if any(w in wrong for w in ["compile", "build", "doesn't run", "syntax"]):
            constraints.append("All code examples must be syntactically correct and compilable")
        if any(w in wrong for w in ["vague", "generic", "wishy", "hand-wav"]):
            constraints.append("Answers must be specific and actionable, not vague or generic")
        return constraints

    def _parse_list(self, text: str) -> list:
        items = []
        for line in text.strip().split("\n"):
            cleaned = line.strip().lstrip("0123456789.-)\u2022* ").strip()
            if cleaned:
                items.append(cleaned)
        return items[:10]

    def _extract_examples(self, text: str):
        if "?" not in text or len(text) < 100:
            return
        parts = text.split("?", 1)
        if len(parts) == 2:
            q = parts[0].strip() + "?"
            a = parts[1].strip()
            if len(q) > 10 and len(a) > 50:
                self.example_pairs.append({"question": q, "answer": a})
