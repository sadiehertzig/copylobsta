"""
AutoImprove response runner.
Runs test questions through a skill, captures responses.

Modes:
    agent_simulation  — inject skill as system prompt, query a model
    tool_simulation   — single grounded Gemini call (real web grounding)
    direct_invocation — call the skill's Python entry point
"""

import asyncio
import hashlib
import importlib.util
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx

from api_utils import GEMINI_SEARCH_TOOL_OPTIONS, send_with_retries
from models import TestCase, DEFAULT_MODEL, empty_usage, add_usage
from spend_tracker import log_usage as log_spend_usage

GEMINI_MODEL = "gemini-2.5-flash"


class ResponseRunner:
    """Runs test questions through a skill and captures responses."""

    def __init__(self):
        self.anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
        self.token_usage = empty_usage()

    def _track_usage(self, raw_usage: dict | None):
        add_usage(self.token_usage, raw_usage)

    @staticmethod
    def _response_hash(text: str) -> str:
        raw = (text or "").replace("\r\n", "\n").strip()
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _gemini_usage(usage_meta: dict | None) -> dict:
        usage_meta = usage_meta or {}
        return {
            "input_tokens": usage_meta.get("promptTokenCount", 0),
            "output_tokens": usage_meta.get("candidatesTokenCount", 0),
            "total_tokens": usage_meta.get("totalTokenCount", 0),
        }

    @staticmethod
    def _extract_gemini_text(payload: dict) -> str:
        candidates = payload.get("candidates", [])
        if not candidates:
            return ""
        parts = candidates[0].get("content", {}).get("parts", [])
        chunks = [p.get("text", "") for p in parts if isinstance(p, dict) and "text" in p]
        return "\n".join(chunks).strip()

    @staticmethod
    def _extract_grounding_urls(payload: dict, limit: int = 5) -> list[str]:
        candidates = payload.get("candidates", [])
        if not candidates:
            return []
        grounding = candidates[0].get("groundingMetadata", {})
        chunks = grounding.get("groundingChunks", [])
        urls = []
        seen = set()
        for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            web = chunk.get("web", {})
            if not isinstance(web, dict):
                continue
            url = str(web.get("uri") or web.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            urls.append(url)
            if len(urls) >= limit:
                break
        return urls

    def consume_usage(self) -> dict:
        usage = dict(self.token_usage)
        self.token_usage = empty_usage()
        return usage

    async def run_one(self, skill_content: str, test_case: TestCase,
                      mode: str = "agent_simulation",
                      model: str = DEFAULT_MODEL,
                      style_notes: str = "",
                      skill_path: str = "") -> dict:
        """Run a single test question."""
        if mode == "direct_invocation":
            return await self._run_direct(skill_path, test_case)
        if mode == "tool_simulation":
            return await self._run_tool_sim(skill_content, test_case, style_notes)
        return await self._run_sim(skill_content, test_case, model, style_notes)

    async def run_batch(self, skill_content: str, test_bank: list,
                        mode: str = "agent_simulation",
                        model: str = DEFAULT_MODEL,
                        concurrency: int = 3,
                        style_notes: str = "",
                        skill_path: str = "") -> list:
        """Run all test questions with bounded concurrency."""
        sem = asyncio.Semaphore(concurrency)

        async def bounded(tc):
            async with sem:
                return await self.run_one(skill_content, tc, mode, model,
                                          style_notes, skill_path)

        return await asyncio.gather(*[bounded(tc) for tc in test_bank])

    async def _run_sim(self, skill_content: str, tc: TestCase, model: str,
                       style_notes: str = "") -> dict:
        if not self.anthropic_key:
            return self._err(tc, "No ANTHROPIC_API_KEY set")

        style_instruction = ""
        if style_notes:
            style_instruction = f"\n\nResponse style: {style_notes}"

        system = (
            "You are an OpenClaw agent with this skill loaded:\n\n"
            f"{skill_content[:12000]}\n\n"
            "Answer the user's question using the knowledge and procedures "
            f"in this skill file. Be specific, concrete, and actionable.{style_instruction}"
        )

        # Build messages with optional conversation history
        messages = []
        if tc.conversation_history:
            for turn in tc.conversation_history:
                messages.append({
                    "role": turn.get("role", "user"),
                    "content": turn.get("content", ""),
                })
        messages.append({"role": "user", "content": tc.question})

        async with httpx.AsyncClient() as client:
            try:
                resp = await send_with_retries(
                    client,
                    "POST",
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": self.anthropic_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": model,
                        "max_tokens": 4096,
                        "system": system,
                        "messages": messages,
                    },
                    timeout=120.0,
                    max_attempts=4,
                    component="runner.agent_sim",
                )
                payload = resp.json()
                self._track_usage(payload.get("usage"))
                log_spend_usage(
                    provider="anthropic",
                    api_key_label="autoimprove-runner-agent-sim",
                    model=model,
                    usage=payload.get("usage", {}),
                )
                text = payload["content"][0]["text"]
                result = {
                    "test_id": tc.id,
                    "question": tc.question,
                    "response": text,
                    "response_hash": self._response_hash(text),
                    "key_assertions": tc.key_assertions,
                    "anti_assertions": tc.anti_assertions,
                    "rubric": tc.rubric,
                    "test_tier": tc.tier,
                    "difficulty": tc.difficulty,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "model": model,
                    "mode": "agent_simulation",
                    "token_usage": payload.get("usage", {}),
                    "error": False,
                }
                if tc.conversation_history:
                    result["conversation_history"] = tc.conversation_history
                return result
            except Exception as e:
                return self._err(tc, str(e))

    async def _run_tool_sim(self, skill_content: str, tc: TestCase,
                            style_notes: str = "") -> dict:
        """
        Run with a single Gemini grounded call.
        This avoids nested Gemini-in-Gemini tool execution loops.
        """
        api_key = os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            return self._err(tc, "No GEMINI_API_KEY set")

        style_instruction = ""
        if style_notes:
            style_instruction = f"\n\nResponse style: {style_notes}"

        system = (
            "You are an OpenClaw agent with this skill loaded:\n\n"
            f"{skill_content[:12000]}\n\n"
            "Answer the user's question using the knowledge and procedures "
            "in this skill file. Be specific, concrete, and actionable. "
            "You have web grounding available via Gemini search tools. "
            "If the skill refers to web_search/web_fetch, satisfy that intent "
            f"using grounded web results in this same response.{style_instruction}"
        )

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{GEMINI_MODEL}:generateContent"
        )
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        }

        last_error = "Gemini tool simulation failed"
        total_usage = empty_usage()

        # Build contents with optional conversation history
        contents = []
        if tc.conversation_history:
            for turn in tc.conversation_history:
                role = turn.get("role", "user")
                # Gemini uses "model" instead of "assistant"
                gemini_role = "model" if role == "assistant" else "user"
                contents.append({
                    "role": gemini_role,
                    "parts": [{"text": turn.get("content", "")}],
                })
        contents.append({"role": "user", "parts": [{"text": tc.question}]})

        async with httpx.AsyncClient() as client:
            for tools in GEMINI_SEARCH_TOOL_OPTIONS + [None]:
                body = {
                    "system_instruction": {"parts": [{"text": system}]},
                    "contents": contents,
                    "generationConfig": {"maxOutputTokens": 4096},
                }
                if tools is not None:
                    body["tools"] = tools

                try:
                    resp = await send_with_retries(
                        client,
                        "POST",
                        url,
                        headers=headers,
                        json=body,
                        timeout=120.0,
                        max_attempts=4,
                        component="runner.tool_sim",
                    )
                    payload = resp.json()
                except Exception as e:
                    last_error = str(e)
                    continue

                add_usage(total_usage, self._gemini_usage(payload.get("usageMetadata", {})))
                log_spend_usage(
                    provider="google",
                    api_key_label="autoimprove-runner-tool-sim",
                    model=GEMINI_MODEL,
                    usage=payload.get("usageMetadata", {}),
                )
                text = self._extract_gemini_text(payload)
                if not text:
                    last_error = "Gemini returned no text response"
                    continue

                sources = self._extract_grounding_urls(payload)
                if sources:
                    text = text.rstrip() + "\n\nSources:\n" + "\n".join(f"- {u}" for u in sources)

                self._track_usage(total_usage)
                result = {
                    "test_id": tc.id,
                    "question": tc.question,
                    "response": text,
                    "response_hash": self._response_hash(text),
                    "key_assertions": tc.key_assertions,
                    "anti_assertions": tc.anti_assertions,
                    "rubric": tc.rubric,
                    "test_tier": tc.tier,
                    "difficulty": tc.difficulty,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "model": GEMINI_MODEL,
                    "mode": "tool_simulation",
                    "token_usage": dict(total_usage),
                    "error": False,
                }
                if tc.conversation_history:
                    result["conversation_history"] = tc.conversation_history
                return result

        self._track_usage(total_usage)
        return self._err(tc, last_error)

    def _find_entry_point(self, skill_path: str) -> str | None:
        """
        Locate the Python entry point for a skill.

        If skill_path is a .py file, use it directly.
        If it's a .md file or directory, scan the parent/directory for
        .py files containing handle_skill_request.
        """
        p = Path(skill_path)

        # Direct .py file
        if p.suffix == ".py" and p.exists():
            return str(p)

        # Determine directory to scan
        if p.is_dir():
            scan_dir = p
        elif p.exists():
            scan_dir = p.parent
        else:
            return None

        # Look for .py files with handle_skill_request
        for py_file in sorted(scan_dir.glob("*.py")):
            if py_file.name.startswith("__"):
                continue
            try:
                text = py_file.read_text()
                if "def handle_skill_request" in text:
                    return str(py_file)
            except OSError:
                continue

        return None

    async def _run_direct(self, skill_path: str, tc: TestCase) -> dict:
        if not skill_path:
            return self._err(tc, "No skill_path provided for direct_invocation mode")

        entry_point = self._find_entry_point(skill_path)
        if not entry_point:
            return self._err(tc, f"No Python entry point with handle_skill_request found near {skill_path}")

        try:
            spec = importlib.util.spec_from_file_location("skill_mod", entry_point)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            if hasattr(module, "handle_skill_request"):
                fn = module.handle_skill_request
                if asyncio.iscoroutinefunction(fn):
                    response = await fn(tc.question)
                else:
                    response = fn(tc.question)
            elif hasattr(module, "main"):
                response = module.main(tc.question)
            else:
                return self._err(tc, "No callable entry point (handle_skill_request or main)")

            return {
                "test_id": tc.id, "question": tc.question,
                "response": str(response),
                "response_hash": self._response_hash(str(response)),
                "key_assertions": tc.key_assertions,
                "anti_assertions": tc.anti_assertions,
                "rubric": tc.rubric,
                "test_tier": tc.tier,
                "difficulty": tc.difficulty,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "mode": "direct_invocation",
                "token_usage": {},
                "error": False,
            }
        except Exception as e:
            return self._err(tc, str(e))

    def _err(self, tc: TestCase, msg: str) -> dict:
        return {
            "test_id": tc.id, "question": tc.question,
            "response": f"ERROR: {msg}",
            "response_hash": "",
            "key_assertions": tc.key_assertions,
            "anti_assertions": tc.anti_assertions,
            "rubric": [],
            "test_tier": tc.tier,
            "difficulty": tc.difficulty,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "mode": "error",
            "token_usage": {},
            "error": True,
        }
