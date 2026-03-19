"""
AutoImprove improver agent.
Proposes one surgical edit per iteration to address failing test questions.
"""

import json
import os
import sys
from pathlib import Path

import httpx

from api_utils import send_with_retries
from models import AutoImproveConfig, DEFAULT_MODEL, parse_json_obj, empty_usage, add_usage
from spend_tracker import log_usage as log_spend_usage


IMPROVER_PROMPT = """\
You are a skill file improvement agent for OpenClaw.

Make ONE surgical edit to the skill file to improve its ability to answer \
the failing test questions below — without regressing any high-scoring tests.

SKILL FILE:
---
{skill_content}
---

IMPROVEMENT PRIORITIES:
{priorities}

AUDIENCE: {audience}

CONSTRAINTS (the skill must avoid violating these):
{constraints}

SAFETY RULES (the skill must NEVER do these):
{safety_rules}

CURRENT SCORES (protect high-scorers — do NOT regress these):
{all_scores}

WORST-SCORING TEST QUESTIONS (improve these):
{worst_questions}

PREVIOUSLY TRIED AND REVERTED (learn from these failures):
{edit_history}

RULES:
- ONE focused edit per iteration
- You may ADD new sections, examples, edge cases, or patterns
- You may EXPAND existing content with more detail
- You may REWRITE an existing section to tighten or clarify its rules \
(use edit_type "rewrite_section" with section_heading to identify which section)
- Do NOT delete entire sections without replacement
- Do NOT touch the YAML front matter or trigger phrases
- Your edit must directly help at least one failing question
- Your edit must NOT regress any test currently scoring above 0.80
- Your edit must NOT violate any constraint or safety rule listed above
- For add/expand edits: content_to_add should be valid markdown, ready to insert
- For rewrite edits: content_to_add replaces the identified section's body

Return ONLY a JSON object (no markdown fences, no commentary):
{{"edit_description":"what and why","edit_type":"add_section|expand_existing|add_example|add_edge_case|rewrite_section","insert_after":"exact line from skill file to insert after (ignored for rewrite_section)","section_heading":"heading of section to rewrite (only for rewrite_section)","content_to_add":"the new or replacement content"}}
"""


IMPROVER_FALLBACKS = {
    "claude-opus-4-6": ("claude-sonnet-4-6",),
    "claude-sonnet-4-6": ("claude-3-5-haiku-latest",),
    "claude-3-7-sonnet-latest": ("claude-3-5-haiku-latest",),
}


class Improver:
    """Proposes and applies targeted skill file edits."""

    MAX_PARSE_ATTEMPTS = 3

    def __init__(self):
        self.api_key = os.environ.get("ANTHROPIC_API_KEY")
        self.model_chain = self._resolve_model_chain()
        self.token_usage = empty_usage()

    @staticmethod
    def _dedupe_chain(items: list[str]) -> list[str]:
        out = []
        seen = set()
        for item in items:
            model_id = str(item or "").strip()
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            out.append(model_id)
        return out

    @classmethod
    def _resolve_model_chain(cls) -> list[str]:
        chain_env = os.environ.get("AUTOIMPROVE_IMPROVER_MODEL_CHAIN", "").strip()
        if chain_env:
            return cls._dedupe_chain([part for part in chain_env.split(",")])

        primary = os.environ.get("AUTOIMPROVE_IMPROVER_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
        chain = [primary]

        explicit_fallback = os.environ.get("AUTOIMPROVE_IMPROVER_FALLBACK_MODEL", "").strip()
        if explicit_fallback:
            chain.append(explicit_fallback)
        else:
            chain.extend(IMPROVER_FALLBACKS.get(primary, ()))

        return cls._dedupe_chain(chain)

    def _track_usage(self, raw_usage: dict | None):
        add_usage(self.token_usage, raw_usage)

    def consume_usage(self) -> dict:
        usage = dict(self.token_usage)
        self.token_usage = empty_usage()
        return usage

    @staticmethod
    def _extract_balanced_json_object(text: str) -> str:
        start = text.find("{")
        if start < 0:
            return ""

        depth = 0
        in_string = False
        escape = False
        for idx in range(start, len(text)):
            ch = text[idx]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue

            if ch == '"':
                in_string = True
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start:idx + 1]

        return ""

    @staticmethod
    def _sanitize_edit(edit: dict | None) -> dict | None:
        if not isinstance(edit, dict):
            return None

        desc = str(edit.get("edit_description", "")).strip()
        edit_type = str(edit.get("edit_type", "add_section")).strip() or "add_section"
        insert_after = str(edit.get("insert_after", "")).strip()
        content_to_add = str(edit.get("content_to_add", "")).strip()
        section_heading = str(edit.get("section_heading", "")).strip()

        if not content_to_add:
            return None

        result = {
            "edit_description": desc or "Add targeted guidance for failing tests",
            "edit_type": edit_type,
            "insert_after": insert_after,
            "content_to_add": content_to_add,
        }
        if section_heading:
            result["section_heading"] = section_heading
        return result

    def _parse_edit_response(self, text: str) -> dict | None:
        # Fast path.
        parsed = parse_json_obj(text)
        normalized = self._sanitize_edit(parsed)
        if normalized:
            return normalized

        # Repair path 1: extract balanced object and parse.
        candidate = self._extract_balanced_json_object(text)
        if candidate:
            normalized = self._sanitize_edit(parse_json_obj(candidate))
            if normalized:
                return normalized

        # Repair path 2: normalize quote variants then retry.
        cleaned = (
            text.replace("\u201c", '"')
            .replace("\u201d", '"')
            .replace("\u2018", "'")
            .replace("\u2019", "'")
        )
        normalized = self._sanitize_edit(parse_json_obj(cleaned))
        if normalized:
            return normalized

        candidate = self._extract_balanced_json_object(cleaned)
        if candidate:
            normalized = self._sanitize_edit(parse_json_obj(candidate))
            if normalized:
                return normalized

        return None

    @staticmethod
    def _rewrite_section(content: str, heading: str, new_body: str) -> str | None:
        """Replace the body of a markdown section, preserving the heading.

        Finds the section by fuzzy-matching heading text. Replaces everything
        from the line after the heading until the next same-or-higher-level
        heading (or EOF).
        """
        import re as _re
        lines = content.split("\n")
        heading_lower = heading.lower().strip().lstrip("#").strip()

        # Find the heading line
        best_idx = -1
        best_score = 0.0
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped.startswith("#"):
                continue
            line_text = stripped.lstrip("#").strip().lower()
            if not line_text:
                continue
            # Exact match
            if line_text == heading_lower:
                best_idx = i
                best_score = 1.0
                break
            # Word overlap
            hw = set(heading_lower.split())
            lw = set(line_text.split())
            if hw and lw:
                overlap = len(hw & lw) / max(len(hw), len(lw))
                if overlap > best_score:
                    best_score = overlap
                    best_idx = i

        if best_idx < 0 or best_score < 0.5:
            return None

        # Determine heading level
        heading_line = lines[best_idx]
        level = len(heading_line) - len(heading_line.lstrip("#"))

        # Find end of section (next heading at same or higher level, or EOF)
        end_idx = len(lines)
        for j in range(best_idx + 1, len(lines)):
            stripped = lines[j].strip()
            if stripped.startswith("#"):
                j_level = len(stripped) - len(stripped.lstrip("#"))
                if j_level <= level:
                    end_idx = j
                    break

        # Rebuild: heading + new body + rest
        result_lines = lines[:best_idx + 1]
        result_lines.append("")
        result_lines.append(new_body)
        result_lines.append("")
        result_lines.extend(lines[end_idx:])
        return "\n".join(result_lines)

    @staticmethod
    def _default_anchor(skill_content: str) -> str:
        for line in skill_content.splitlines():
            s = line.strip()
            if s.startswith("## "):
                return line
        for line in skill_content.splitlines():
            s = line.strip()
            if s.startswith("# "):
                return line
        return ""

    def _fallback_edit(self, skill_content: str, worst_questions: list) -> dict:
        worst_question = ""
        if worst_questions:
            worst_question = str(worst_questions[0].get("question", "")).strip()

        content = (
            "## Reliability And Evidence Guardrails\n\n"
            "When evidence is weak, contradictory, or unavailable:\n"
            "- Say exactly what is unknown instead of guessing.\n"
            "- Prefer transparent uncertainty language over confident speculation.\n"
            "- If a claim cannot be verified, state that directly and ask a clarifying follow-up.\n"
            "- Never fabricate source names, URLs, dates, or quantitative results.\n"
        )
        if worst_question:
            content += f"\nApplies especially to this failing pattern: \"{worst_question}\".\n"

        return {
            "edit_description": (
                "Add reliability guardrails to reduce hallucinations "
                "when evidence is uncertain"
            ),
            "edit_type": "add_section",
            "insert_after": self._default_anchor(skill_content),
            "content_to_add": content,
        }

    async def _request_with_failover(self, client: httpx.AsyncClient, messages: list) -> str:
        last_error = None
        chain = self.model_chain or [DEFAULT_MODEL]

        for idx, model_id in enumerate(chain):
            try:
                resp = await send_with_retries(
                    client,
                    "POST",
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": self.api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": model_id,
                        "max_tokens": 4096,
                        "messages": messages,
                    },
                    timeout=120.0,
                    max_attempts=4,
                    component=f"improver.propose:{model_id}",
                )
                payload = resp.json()
                self._track_usage(payload.get("usage"))
                log_spend_usage(
                    provider="anthropic",
                    api_key_label="autoimprove-improver",
                    model=model_id,
                    usage=payload.get("usage", {}),
                )
                return payload["content"][0]["text"]
            except Exception as e:
                last_error = e
                if idx < len(chain) - 1:
                    print(
                        f"Improver model {model_id} failed; "
                        f"falling back to {chain[idx + 1]}: {e}",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"Improver model {model_id} failed with no remaining fallback: {e}",
                        file=sys.stderr,
                    )

        if last_error:
            raise last_error
        raise RuntimeError("Improver model chain is empty")

    async def propose(self, skill_content: str, config: AutoImproveConfig,
                      worst_questions: list, edit_history: str = "",
                      all_scores: str = "") -> dict:
        """
        Propose one edit. Returns dict with edit_description, insert_after,
        content_to_add, etc. Returns deterministic fallback on parse failure.
        """
        if not self.api_key:
            return None

        prompt = IMPROVER_PROMPT.format(
            skill_content=skill_content[:8000],
            priorities="\n".join(f"- {p}" for p in config.priorities) or "None",
            audience=f"{config.audience} ({config.expertise_level})",
            constraints="\n".join(f"- {c}" for c in config.constraints) or "None specified",
            safety_rules="\n".join(f"- {s}" for s in config.safety_rules) or "None specified",
            all_scores=all_scores or "No scores yet.",
            worst_questions=json.dumps(worst_questions[:5], indent=2),
            edit_history=edit_history[-3000:] or "None yet.",
        )

        messages = [{"role": "user", "content": prompt}]

        try:
            async with httpx.AsyncClient() as client:
                for attempt in range(self.MAX_PARSE_ATTEMPTS):
                    text = await self._request_with_failover(client, messages)

                    parsed = self._parse_edit_response(text)
                    if parsed:
                        return parsed

                    # Retry with a stricter repair prompt.
                    if attempt < self.MAX_PARSE_ATTEMPTS - 1:
                        messages.append({"role": "assistant", "content": text[:3000]})
                        messages.append({
                            "role": "user",
                            "content": (
                                "Your last response was invalid JSON for strict parsing. "
                                "Return ONLY one valid JSON object with double-quoted strings. "
                                "Escape newlines in content_to_add as \\n and do not include commentary."
                            ),
                        })

                return self._fallback_edit(skill_content, worst_questions)
        except Exception as e:
            print(f"Improver error: {e}", file=sys.stderr)
            return self._fallback_edit(skill_content, worst_questions)

    def apply(self, skill_path: str, edit: dict) -> bool:
        """
        Apply edit to file. Tries exact match, then fuzzy match,
        then appends to end as last resort. Returns True if applied.
        """
        if not edit:
            return False

        content = Path(skill_path).read_text()
        anchor = edit.get("insert_after", "")
        new_text = edit.get("content_to_add", "")

        if not new_text:
            return False

        # Handle rewrite_section: replace the body of an existing section
        if edit.get("edit_type") == "rewrite_section":
            heading = edit.get("section_heading", "").strip()
            if heading:
                result = self._rewrite_section(content, heading, new_text)
                if result is not None:
                    Path(skill_path).write_text(result)
                    return True
            # Fall through to normal insert if section not found

        if not anchor:
            # No anchor — append to end
            Path(skill_path).write_text(content.rstrip() + "\n\n" + new_text + "\n")
            return True

        # Try 1: Exact substring match
        idx = content.find(anchor)
        if idx >= 0:
            eol = content.find("\n", idx + len(anchor))
            if eol < 0:
                eol = len(content)
            Path(skill_path).write_text(
                content[:eol] + "\n\n" + new_text + content[eol:]
            )
            return True

        # Try 2: Fuzzy line match (word overlap)
        lines = content.split("\n")
        anchor_words = set(anchor.lower().split())
        best_i, best_score = -1, 0.0
        for i, line in enumerate(lines):
            lw = set(line.lower().strip().split())
            if not lw or not anchor_words:
                continue
            overlap = len(anchor_words & lw) / max(len(anchor_words), len(lw))
            if overlap > best_score:
                best_score = overlap
                best_i = i

        if best_score > 0.5 and best_i >= 0:
            lines.insert(best_i + 1, "\n" + new_text)
            Path(skill_path).write_text("\n".join(lines))
            return True

        # Try 3: Append to end
        Path(skill_path).write_text(content.rstrip() + "\n\n" + new_text + "\n")
        return True
