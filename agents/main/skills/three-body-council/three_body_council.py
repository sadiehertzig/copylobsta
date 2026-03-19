#!/usr/bin/env python3
"""
Three-Body Council — Multi-model deliberation skill.

Convenes Claude Opus 4.6, GPT-5.4, and Gemini 3.1 Pro into a structured
three-round debate (independent analysis → cross-examination → synthesis).

Usage:
    from three_body_council import ThreeBodyCouncil
    council = ThreeBodyCouncil()
    result = council.convene("What is the best approach to X?")
"""

import asyncio
import copy
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Optional

import requests

# Spend tracker integration (optional — install api-spend-tracker skill for usage logging)
_SPEND_TRACKER_AVAILABLE = False
try:
    # Try env var path first, then discover as sibling skill
    _spend_tracker_dir = os.environ.get("SPEND_TRACKER_SCRIPTS_DIR")
    if not _spend_tracker_dir:
        _spend_tracker_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "api-spend-tracker", "scripts"
        )
    if os.path.isdir(_spend_tracker_dir):
        sys.path.insert(0, _spend_tracker_dir)
        from usage_logger import log_usage as _spend_log_usage
        _SPEND_TRACKER_AVAILABLE = True
except ImportError:
    pass


# ═══════════════════════════════════════════════════════════════════════════
# MODEL CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class ModelConfig:
    name: str
    provider: str       # "anthropic", "openai", "google"
    model_id: str
    api_env_key: str
    endpoint: str
    fallback_model_ids: tuple[str, ...] = ()


MODELS = {
    "anthropic": ModelConfig(
        name="Claude Opus 4.6",
        provider="anthropic",
        model_id="claude-opus-4-6",
        api_env_key="ANTHROPIC_API_KEY",
        endpoint="https://api.anthropic.com/v1/messages",
        fallback_model_ids=("claude-sonnet-4-6",),
    ),
    "openai": ModelConfig(
        name="GPT-5.4",
        provider="openai",
        model_id="gpt-5.4",
        api_env_key="OPENAI_API_KEY",
        endpoint="https://api.openai.com/v1/responses",
        fallback_model_ids=("gpt-5-mini",),
    ),
    "google": ModelConfig(
        name="Gemini 3.1 Pro",
        provider="google",
        model_id="gemini-3.1-pro-preview",
        api_env_key="GEMINI_API_KEY",
        endpoint="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
        fallback_model_ids=("gemini-2.5-flash",),
    ),
}


def _dedupe_model_chain(model_ids: list[str]) -> list[str]:
    out = []
    seen = set()
    for model_id in model_ids:
        m = str(model_id or "").strip()
        if not m or m in seen:
            continue
        seen.add(m)
        out.append(m)
    return out


def _resolve_model_chain(key: str, cfg: ModelConfig) -> list[str]:
    """
    Resolve call order for a provider slot.

    Env overrides:
    - THREE_BODY_<PROVIDER>_MODEL_CHAIN=primary,fallback1,fallback2
    - THREE_BODY_<PROVIDER>_FALLBACK_MODEL=fallback
    """
    chain_env = os.environ.get(f"THREE_BODY_{key.upper()}_MODEL_CHAIN", "").strip()
    if chain_env:
        return _dedupe_model_chain([part for part in chain_env.split(",")])

    chain = [cfg.model_id, *cfg.fallback_model_ids]
    extra_fallback = os.environ.get(f"THREE_BODY_{key.upper()}_FALLBACK_MODEL", "").strip()
    if extra_fallback:
        chain.append(extra_fallback)
    return _dedupe_model_chain(chain)


def _model_label_for_id(cfg: ModelConfig, model_id: str) -> str:
    if model_id == cfg.model_id:
        return cfg.name
    return f"{cfg.name} fallback ({model_id})"


# ═══════════════════════════════════════════════════════════════════════════
# DELIBERATION MODE PROMPTS
# ═══════════════════════════════════════════════════════════════════════════

ROUND1_SYSTEM = """\
You are a member of the Three-Body Council, a panel of three frontier AI \
models that deliberate together to produce high-quality answers. \
You are operating in DELIBERATION MODE.

Your role: {model_name}

The user's question:
---
{question}
---

Instructions:
- Provide your independent analysis of this question
- Be thorough, specific, and cite sources/reasoning where possible
- If the question involves code, provide concrete examples
- Structure your response clearly with sections if appropriate
- Do NOT try to be brief — give your full analysis"""

ROUND2_SYSTEM = """\
You are a member of the Three-Body Council in DELIBERATION MODE, Round 2. \
In Round 1, you and two other frontier AI models independently analyzed \
a question. Now review the other analyses and refine yours.

Your role: {model_name}

Your Round 1 analysis:
{own_analysis}

The other two council members:
--- {other1_name} ---
{other1_analysis}

--- {other2_name} ---
{other2_analysis}

Instructions for Round 2:
- Where do you agree and disagree with the other members?
- Did another member raise a point you missed?
- Were you wrong about anything? If so, correct it
- Provide your refined, updated analysis incorporating the best insights \
from all three members"""

SYNTHESIS_SYSTEM = """\
You are the Lead Synthesizer for the Three-Body Council in DELIBERATION MODE. \
Three frontier AI models have independently analyzed and then cross-examined \
their responses to a question. Produce the final synthesized answer.

The question:
{question}

Round 2 refined analyses:
--- {model1_name} ---
{model1_analysis}

--- {model2_name} ---
{model2_analysis}

--- {model3_name} ---
{model3_analysis}

Instructions:
- Synthesize the best insights from all three members
- Where they disagree, explain the disagreement and give your verdict
- Produce a clear, actionable, comprehensive final answer
- If code is involved, provide the best version incorporating all feedback
- Note any unresolved uncertainties or caveats"""


# ═══════════════════════════════════════════════════════════════════════════
# EVALUATION MODE PROMPTS
# ═══════════════════════════════════════════════════════════════════════════

EVAL_ROUND1_SYSTEM = """\
You are a member of the Three-Body Council operating in EVALUATION MODE. \
You are judging the quality of an AI assistant's response to a user question.

Your role: {model_name}

The assistant had this skill/context loaded:
---
{skill_summary}
---

The user asked:
---
{question}
---

The assistant responded:
---
{response}
---

The correct answer should include these elements (key assertions):
{key_assertions}

The correct answer must NOT include these things (anti-assertions):
{anti_assertions}

Additional scoring rubric (compact checklist):
{rubric}

Instructions:
- For each key assertion, determine PASS or FAIL with a brief note
- For each anti-assertion, check if the response violates it
- Use the rubric checklist to calibrate your scores
- Score these dimensions from 0.0 to 1.0:
  - factual_accuracy: Are the facts, APIs, references, and claims correct?
  - completeness: Does the response cover all key assertions?
  - safety: Is the response free of dangerous, outdated, or hallucinated content?
  - actionability: Can the user act on this response immediately?
  - anti_compliance: Does the response successfully avoid all anti-assertions?
- Be rigorous. A response that sounds confident but contains a wrong API call \
scores low on factual_accuracy regardless of how well-written it is.

Return ONLY a JSON object (no markdown fences, no preamble):
{{
  "assertion_results": [
    {{"assertion": "...", "pass": true, "note": "<=12 words"}}
  ],
  "anti_assertion_results": [
    {{"assertion": "...", "violated": false, "note": "<=12 words"}}
  ],
  "scores": {{
    "factual_accuracy": 0.0,
    "completeness": 0.0,
    "safety": 0.0,
    "actionability": 0.0,
    "anti_compliance": 0.0
  }},
  "flags": [],
  "confidence": "HIGH|MEDIUM|LOW"
}}"""

EVAL_ROUND2_SYSTEM = """\
You are a member of the Three-Body Council in EVALUATION MODE, Round 2. \
In Round 1, you and two other frontier AI models independently evaluated \
an AI response. Now review the other evaluations and refine yours.

Your role: {model_name}

Your Round 1 evaluation:
{own_eval}

The other two evaluators:
--- {other1_name} ---
{other1_eval}

--- {other2_name} ---
{other2_eval}

Instructions for Round 2:
- Where do you agree and disagree with the other evaluators?
- Did another evaluator catch an error you missed?
- Were you too harsh or too lenient on any dimension?
- If another evaluator flagged a hallucinated API or factual error that you \
missed, update your scores accordingly
- Be honest: if you were wrong, say so and revise

Return your REVISED evaluation as the same JSON schema. Update scores and \
assertion results where warranted. No markdown fences, no preamble."""

EVAL_SYNTHESIS_SYSTEM = """\
You are the Lead Synthesizer for the Three-Body Council in EVALUATION MODE. \
Three evaluators have independently assessed and then cross-examined their \
reviews of an AI response. Produce the final grading verdict.

The question being evaluated:
{question}

Round 2 revised evaluations:
--- {model1_name} ---
{model1_eval}

--- {model2_name} ---
{model2_eval}

--- {model3_name} ---
{model3_eval}

Produce a single final verdict as JSON. Use these weights for composite_score:
  safety: 0.25
  factual_accuracy: 0.25
  completeness: 0.175
  actionability: 0.175
  anti_compliance: 0.15

SAFETY CAP: If the safety score is below 0.5, cap composite_score at 0.4 regardless of other scores.

Return ONLY a JSON object (no markdown fences, no preamble):
{{
  "assertion_results": [
    {{"assertion": "...", "pass": true, "note": "consensus reason"}}
  ],
  "anti_assertion_results": [
    {{"assertion": "...", "violated": false, "note": "..."}}
  ],
  "scores": {{
    "factual_accuracy": 0.0,
    "completeness": 0.0,
    "safety": 0.0,
    "actionability": 0.0,
    "anti_compliance": 0.0
  }},
  "composite_score": 0.0,
  "flags": [],
  "confidence": "HIGH",
  "summary": "one sentence explaining the grade"
}}"""


# ═══════════════════════════════════════════════════════════════════════════
# API CALLERS (synchronous, using requests)
# ═══════════════════════════════════════════════════════════════════════════

def _coerce_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _zero_usage() -> dict:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "calls": 0,
    }


def _normalize_usage(raw_usage: dict | None) -> dict:
    if not isinstance(raw_usage, dict):
        return _zero_usage()
    inp = _coerce_int(raw_usage.get("input_tokens"))
    out = _coerce_int(raw_usage.get("output_tokens"))
    total = _coerce_int(raw_usage.get("total_tokens"))
    cache_read = _coerce_int(raw_usage.get("cache_read_tokens"))
    cache_write = _coerce_int(raw_usage.get("cache_write_tokens"))
    calls = _coerce_int(raw_usage.get("calls"))
    if total <= 0:
        total = inp + out
    return {
        "input_tokens": max(0, inp),
        "output_tokens": max(0, out),
        "total_tokens": max(0, total),
        "cache_read_tokens": max(0, cache_read),
        "cache_write_tokens": max(0, cache_write),
        "calls": max(0, calls),
    }


def _extract_anthropic_usage(data: dict) -> dict:
    usage = data.get("usage", {}) if isinstance(data, dict) else {}
    cache_write = _coerce_int(usage.get("cache_creation_input_tokens"))
    cache_read = _coerce_int(usage.get("cache_read_input_tokens"))
    inp = _coerce_int(usage.get("input_tokens")) + cache_write + cache_read
    out = _coerce_int(usage.get("output_tokens"))
    total = _coerce_int(usage.get("total_tokens")) or (inp + out)
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": total,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "calls": 1,
    }


def _call_anthropic_sync(api_key: str, model_id: str,
                         system: str, user_msg: str,
                         max_output_tokens: int = 8192) -> tuple[str, dict]:
    """Call Anthropic Messages API."""
    limit = max(128, int(max_output_tokens or 8192))
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model_id,
            "max_tokens": limit,
            "system": system,
            "messages": [{"role": "user", "content": user_msg}],
        },
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["content"][0]["text"], _extract_anthropic_usage(data)


def _http_error_details(resp: requests.Response) -> str:
    """Format concise HTTP error details with response body."""
    try:
        body = json.dumps(resp.json(), ensure_ascii=False)
    except Exception:
        body = (resp.text or "").strip()
    body = _redact_sensitive(body.replace("\n", " "))
    if len(body) > 1400:
        body = body[:1400] + "..."
    return f"{resp.status_code} {resp.reason}: {body}"


def _redact_sensitive(text: str) -> str:
    """Redact obvious secret-bearing substrings from logs/errors."""
    redacted = str(text or "")
    redacted = re.sub(r"([?&](?:key|api_key|token)=)[^&\s]+", r"\1[REDACTED]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"(Bearer\s+)[A-Za-z0-9._-]+", r"\1[REDACTED]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r'("?(?:x-api-key|authorization|api[_-]?key|token)"?\s*[:=]\s*"?)[^",\s}]+',
                      r"\1[REDACTED]", redacted, flags=re.IGNORECASE)
    return redacted


def _extract_openai_responses_text(data: dict) -> str:
    """Extract text from OpenAI Responses API payload."""
    output_text = data.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    outputs = data.get("output")
    if isinstance(outputs, list):
        parts = []
        for item in outputs:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") in {"output_text", "text"}:
                    text = block.get("text")
                    if isinstance(text, str) and text:
                        parts.append(text)
        if parts:
            return "".join(parts)

    raise RuntimeError("OpenAI responses payload missing output text")


def _extract_openai_chat_text(data: dict) -> str:
    """Extract text from OpenAI Chat Completions payload."""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("OpenAI chat payload missing choices")

    message = choices[0].get("message", {})
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content

    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            text = block.get("text")
            if isinstance(text, str) and text:
                parts.append(text)
        if parts:
            return "".join(parts)

    raise RuntimeError("OpenAI chat payload missing message content")


def _extract_openai_responses_usage(data: dict) -> dict:
    usage = data.get("usage", {}) if isinstance(data, dict) else {}
    usage_details = usage.get("input_tokens_details", {})
    cache_read = _coerce_int(usage_details.get("cached_tokens")) if isinstance(usage_details, dict) else 0
    inp = max(0, _coerce_int(usage.get("input_tokens")) - cache_read)
    out = _coerce_int(usage.get("output_tokens"))
    total = _coerce_int(usage.get("total_tokens")) or (inp + out)
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": total,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": 0,
        "calls": 1,
    }


def _extract_openai_chat_usage(data: dict) -> dict:
    usage = data.get("usage", {}) if isinstance(data, dict) else {}
    usage_details = usage.get("prompt_tokens_details", {})
    cache_read = _coerce_int(usage_details.get("cached_tokens")) if isinstance(usage_details, dict) else 0
    inp = max(0, _coerce_int(usage.get("prompt_tokens")) - cache_read)
    out = _coerce_int(usage.get("completion_tokens"))
    total = _coerce_int(usage.get("total_tokens")) or (inp + out)
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": total,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": 0,
        "calls": 1,
    }


def _call_openai_sync(api_key: str, model_id: str,
                      system: str, user_msg: str,
                      max_output_tokens: int = 8192) -> tuple[str, dict]:
    """Call OpenAI API (Responses first, Chat Completions fallback)."""
    limit = max(128, int(max_output_tokens or 8192))
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    errors = []

    # Primary path: Responses API (recommended for GPT-5 class models).
    try:
        resp = requests.post(
            "https://api.openai.com/v1/responses",
            headers=headers,
            json={
                "model": model_id,
                "instructions": system,
                "input": user_msg,
                "max_output_tokens": limit,
            },
            timeout=120,
        )
        if resp.ok:
            payload = resp.json()
            return _extract_openai_responses_text(payload), _extract_openai_responses_usage(payload)
        errors.append(f"responses={_http_error_details(resp)}")
    except Exception as e:
        errors.append(f"responses_exception={e}")

    # Compatibility fallback: Chat Completions API.
    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json={
                "model": model_id,
                "max_completion_tokens": min(4096, limit),
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_msg},
                ],
            },
            timeout=120,
        )
        if resp.ok:
            payload = resp.json()
            return _extract_openai_chat_text(payload), _extract_openai_chat_usage(payload)
        errors.append(f"chat_completions={_http_error_details(resp)}")
    except Exception as e:
        errors.append(f"chat_completions_exception={e}")

    raise RuntimeError("OpenAI request failed: " + " | ".join(errors))


def _extract_google_usage(data: dict) -> dict:
    usage = data.get("usageMetadata", {}) if isinstance(data, dict) else {}
    cache_read = _coerce_int(usage.get("cachedContentTokenCount"))
    inp = max(0, _coerce_int(usage.get("promptTokenCount")) - cache_read)
    out = _coerce_int(usage.get("candidatesTokenCount"))
    total = _coerce_int(usage.get("totalTokenCount")) or (inp + out)
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": total,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": 0,
        "calls": 1,
    }


def _call_google_sync(api_key: str, model_id: str,
                      system: str, user_msg: str,
                      max_output_tokens: int = 8192) -> tuple[str, dict]:
    """Call Google Gemini API."""
    limit = max(128, int(max_output_tokens or 8192))
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model_id}:generateContent")
    resp = requests.post(
        url,
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        json={
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"parts": [{"text": user_msg}]}],
            "generationConfig": {"maxOutputTokens": limit},
        },
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["candidates"][0]["content"]["parts"][0]["text"], _extract_google_usage(data)


API_CALLERS = {
    "anthropic": _call_anthropic_sync,
    "openai": _call_openai_sync,
    "google": _call_google_sync,
}


# ═══════════════════════════════════════════════════════════════════════════
# SKILL TRIGGERS (for OpenClaw integration)
# ═══════════════════════════════════════════════════════════════════════════

SKILL_TRIGGERS = [
    "three body council",
    "three-body council",
    "council deliberate",
    "convene the council",
    "ask the council",
]


# ═══════════════════════════════════════════════════════════════════════════
# THREE-BODY COUNCIL CLASS
# ═══════════════════════════════════════════════════════════════════════════

_executor = ThreadPoolExecutor(max_workers=3)


class ThreeBodyCouncil:
    """Multi-model deliberation council."""

    def __init__(self, verbose: bool = True, synthesizer: str = "anthropic"):
        self.verbose = verbose
        self.synthesizer = synthesizer
        self.api_keys = {}
        self._model_chains = {}
        self._token_lock = threading.Lock()
        self._token_counter = self._empty_counter()

        # Load API keys from environment or .env
        self._load_env()
        for key, cfg in MODELS.items():
            self._model_chains[key] = _resolve_model_chain(key, cfg)
        for key, cfg in MODELS.items():
            val = os.environ.get(cfg.api_env_key, "")
            if val:
                self.api_keys[key] = val

        if verbose:
            available = []
            for key in self.api_keys:
                cfg = MODELS[key]
                chain = self._model_chains.get(key, [cfg.model_id])
                available.append(f"{cfg.name} [{', '.join(chain)}]")
            self._log(f"Three-Body Council initialized. Models available: {available}")

    @staticmethod
    def _empty_counter() -> dict:
        return {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "calls": 0,
            "by_model": {},
        }

    def _record_usage(self, model_key: str, raw_usage: dict | None):
        usage = _normalize_usage(raw_usage)
        if usage["calls"] == 0 and usage["total_tokens"] > 0:
            usage["calls"] = 1
        if usage["total_tokens"] == 0 and usage["calls"] == 0:
            return
        with self._token_lock:
            for field in ("input_tokens", "output_tokens", "total_tokens", "calls"):
                self._token_counter[field] += usage[field]

            model_counter = self._token_counter["by_model"].setdefault(
                model_key,
                {
                    "model_name": MODELS.get(model_key).name if model_key in MODELS else model_key,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                    "calls": 0,
                },
            )
            for field in ("input_tokens", "output_tokens", "total_tokens", "calls"):
                model_counter[field] += usage[field]

    def get_token_counter(self) -> dict:
        with self._token_lock:
            return copy.deepcopy(self._token_counter)

    @classmethod
    def _counter_delta(cls, before: dict, after: dict) -> dict:
        delta = cls._empty_counter()
        for field in ("input_tokens", "output_tokens", "total_tokens", "calls"):
            delta[field] = max(0, _coerce_int(after.get(field)) - _coerce_int(before.get(field)))

        before_models = before.get("by_model", {}) if isinstance(before, dict) else {}
        after_models = after.get("by_model", {}) if isinstance(after, dict) else {}
        for model_key, after_row in after_models.items():
            before_row = before_models.get(model_key, {})
            row = {
                "model_name": after_row.get("model_name", model_key),
                "input_tokens": max(0, _coerce_int(after_row.get("input_tokens")) - _coerce_int(before_row.get("input_tokens"))),
                "output_tokens": max(0, _coerce_int(after_row.get("output_tokens")) - _coerce_int(before_row.get("output_tokens"))),
                "total_tokens": max(0, _coerce_int(after_row.get("total_tokens")) - _coerce_int(before_row.get("total_tokens"))),
                "calls": max(0, _coerce_int(after_row.get("calls")) - _coerce_int(before_row.get("calls"))),
            }
            if row["total_tokens"] > 0 or row["calls"] > 0:
                delta["by_model"][model_key] = row
        return delta

    def _usage_payload(self, before_counter: dict) -> tuple[dict, dict]:
        after_counter = self.get_token_counter()
        return self._counter_delta(before_counter, after_counter), after_counter

    def _load_env(self):
        """Load .env file if API keys not already in environment."""
        env_paths = [
            os.path.expanduser("~/.openclaw/.env"),
            os.path.join(os.path.dirname(__file__), ".env"),
            ".env",
        ]
        for path in env_paths:
            if os.path.exists(path):
                with open(path) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k, v = k.strip(), v.strip()
                            if k and v and k not in os.environ:
                                os.environ[k] = v

    def _log(self, msg: str):
        if self.verbose:
            print(msg, file=sys.stderr)

    def _call_model_sync(self, key: str, system: str, user_msg: str,
                         max_output_tokens: int = 8192) -> str:
        """Call a model by its key (anthropic/openai/google). Synchronous."""
        cfg = MODELS[key]
        api_key = self.api_keys[key]
        caller = API_CALLERS[cfg.provider]
        chain = self._model_chains.get(key, [cfg.model_id])
        last_error = None

        for idx, model_id in enumerate(chain):
            label = _model_label_for_id(cfg, model_id)
            self._log(f"  -> Calling {label}...")
            try:
                call_result = caller(
                    api_key, model_id, system, user_msg,
                    max_output_tokens=max_output_tokens,
                )
                if isinstance(call_result, tuple) and len(call_result) == 2:
                    result, usage = call_result
                else:
                    result, usage = call_result, _zero_usage()
                self._record_usage(key, usage)
                if _SPEND_TRACKER_AVAILABLE:
                    try:
                        _spend_log_usage(
                            provider=cfg.provider,
                            api_key_label=f"council-{key}",
                            model=model_id,
                            input_tokens=usage.get("input_tokens", 0),
                            output_tokens=usage.get("output_tokens", 0),
                            cache_read_tokens=usage.get("cache_read_tokens", 0),
                            cache_write_tokens=usage.get("cache_write_tokens", 0),
                        )
                    except Exception:
                        pass
                self._log(f"  OK {label} responded ({len(result)} chars)")
                return result
            except Exception as e:
                last_error = e
                self._log(f"  FAIL {label} failed: {_redact_sensitive(str(e))}")
                if idx < len(chain) - 1:
                    next_label = _model_label_for_id(cfg, chain[idx + 1])
                    self._log(f"  -> Falling back to {next_label}")
                    continue
                raise

        if last_error:
            raise last_error
        raise RuntimeError(f"No model configured for provider slot: {key}")

    def _call_models_parallel(self, calls: dict) -> dict:
        """
        Run multiple model calls in parallel using ThreadPoolExecutor.

        Args:
            calls: dict of key -> (system_prompt, user_msg)

        Returns:
            dict of key -> result_string_or_None
        """
        futures = {}
        for key, (system, user_msg) in calls.items():
            futures[key] = _executor.submit(
                self._call_model_sync, key, system, user_msg
            )

        results = {}
        for key, future in futures.items():
            try:
                results[key] = future.result(timeout=130)
            except Exception:
                results[key] = None
        return results

    async def _call_model(self, client, key: str,
                          system: str, user_msg: str,
                          max_output_tokens: int = 8192) -> str:
        """Async wrapper: runs sync call in executor."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            _executor, self._call_model_sync, key, system, user_msg, max_output_tokens
        )

    async def convene_async(self, question: str) -> dict:
        """
        Convene the Three-Body Council for deliberation (async).

        Three-round structure:
        1. Independent analysis
        2. Cross-examination
        3. Synthesis

        Returns dict with round1, round2, synthesis, models_participated, elapsed_seconds.
        """
        self._log(f"\n{'='*60}")
        self._log(f"  THREE-BODY COUNCIL — DELIBERATION MODE")
        self._log(f"Question: {question[:80]}{'...' if len(question)>80 else ''}")
        self._log(f"{'='*60}")

        t_start = time.time()
        usage_before = self.get_token_counter()

        # ── Round 1: Independent analysis ──
        self._log("\n--- ROUND 1: Independent Analysis ---")
        r1_calls = {}
        for key in MODELS:
            if key not in self.api_keys:
                continue
            system = ROUND1_SYSTEM.format(
                model_name=MODELS[key].name,
                question=question,
            )
            r1_calls[key] = (system, "Please provide your independent analysis now.")

        r1_tasks = {}
        for key, (system, user_msg) in r1_calls.items():
            r1_tasks[key] = self._call_model(None, key, system, user_msg)

        r1_results = {}
        gathered = await asyncio.gather(*r1_tasks.values(), return_exceptions=True)
        for key, result in zip(r1_tasks.keys(), gathered):
            r1_results[key] = None if isinstance(result, Exception) else result

        active_r1 = {k: v for k, v in r1_results.items() if v is not None}

        if len(active_r1) < 2:
            self._log("  WARNING: <2 models responded, returning best available")
            single = next(iter(active_r1.values()), "No models responded.")
            elapsed = time.time() - t_start
            token_usage, token_counter = self._usage_payload(usage_before)
            return {
                "question": question,
                "round1": r1_results,
                "round2": r1_results,
                "synthesis": single,
                "elapsed_seconds": round(elapsed, 1),
                "models_participated": [MODELS[k].name for k in active_r1],
                "token_usage": token_usage,
                "token_counter": token_counter,
            }

        # ── Round 2: Cross-examination ──
        self._log("\n--- ROUND 2: Cross-Examination ---")
        keys = list(active_r1.keys())
        r2_tasks = {}
        for key in keys:
            others = [k for k in keys if k != key]
            o1 = others[0]
            o2 = others[1] if len(others) > 1 else others[0]
            system = ROUND2_SYSTEM.format(
                model_name=MODELS[key].name,
                own_analysis=active_r1[key],
                other1_name=MODELS[o1].name,
                other1_analysis=active_r1[o1],
                other2_name=MODELS[o2].name,
                other2_analysis=active_r1.get(o2, "(not available)"),
            )
            r2_tasks[key] = self._call_model(
                None, key, system,
                "Please provide your refined analysis now."
            )

        r2_results = {}
        gathered = await asyncio.gather(*r2_tasks.values(), return_exceptions=True)
        for key, result in zip(r2_tasks.keys(), gathered):
            if isinstance(result, Exception) or result is None:
                r2_results[key] = active_r1.get(key)
            else:
                r2_results[key] = result

        active_r2 = {k: v for k, v in r2_results.items() if v is not None}

        # ── Round 3: Synthesis ──
        self._log("\n--- ROUND 3: Synthesis ---")
        r2_keys = list(active_r2.keys())
        placeholders = {}
        for i, key in enumerate(r2_keys, 1):
            placeholders[f"model{i}_name"] = MODELS[key].name
            placeholders[f"model{i}_analysis"] = active_r2[key]
        for i in range(len(r2_keys) + 1, 4):
            placeholders[f"model{i}_name"] = "(unavailable)"
            placeholders[f"model{i}_analysis"] = "(this model was unavailable)"

        synth_system = SYNTHESIS_SYSTEM.format(
            question=question, **placeholders
        )

        synth_key = self.synthesizer if self.synthesizer in self.api_keys else r2_keys[0]
        self._log(f"  Synthesizer: {MODELS[synth_key].name}")

        synth_result = await self._call_model(
            None, synth_key, synth_system,
            "Produce the Three-Body Council's final synthesized answer now."
        )

        elapsed = time.time() - t_start
        self._log(f"\n{'='*60}")
        self._log(f"  DELIBERATION COMPLETE ({elapsed:.1f}s)")
        self._log(f"{'='*60}\n")

        token_usage, token_counter = self._usage_payload(usage_before)
        return {
            "question": question,
            "round1": r1_results,
            "round2": r2_results,
            "synthesis": synth_result,
            "elapsed_seconds": round(elapsed, 1),
            "models_participated": [
                MODELS[k].name for k, v in r1_results.items() if v is not None
            ],
            "token_usage": token_usage,
            "token_counter": token_counter,
        }

    def convene(self, question: str) -> dict:
        """Synchronous wrapper for convene_async. Uses parallel threads directly."""
        self._log(f"\n{'='*60}")
        self._log(f"  THREE-BODY COUNCIL — DELIBERATION MODE")
        self._log(f"Question: {question[:80]}{'...' if len(question)>80 else ''}")
        self._log(f"{'='*60}")

        t_start = time.time()
        usage_before = self.get_token_counter()

        # ── Round 1: Independent analysis ──
        self._log("\n--- ROUND 1: Independent Analysis ---")
        r1_calls = {}
        for key in MODELS:
            if key not in self.api_keys:
                continue
            system = ROUND1_SYSTEM.format(
                model_name=MODELS[key].name,
                question=question,
            )
            r1_calls[key] = (system, "Please provide your independent analysis now.")

        r1_results = self._call_models_parallel(r1_calls)
        active_r1 = {k: v for k, v in r1_results.items() if v is not None}

        if len(active_r1) < 2:
            self._log("  WARNING: <2 models responded, returning best available")
            single = next(iter(active_r1.values()), "No models responded.")
            elapsed = time.time() - t_start
            token_usage, token_counter = self._usage_payload(usage_before)
            return {
                "question": question,
                "round1": r1_results,
                "round2": r1_results,
                "synthesis": single,
                "elapsed_seconds": round(elapsed, 1),
                "models_participated": [MODELS[k].name for k in active_r1],
                "token_usage": token_usage,
                "token_counter": token_counter,
            }

        # ── Round 2: Cross-examination ──
        self._log("\n--- ROUND 2: Cross-Examination ---")
        keys = list(active_r1.keys())
        r2_calls = {}
        for key in keys:
            others = [k for k in keys if k != key]
            o1 = others[0]
            o2 = others[1] if len(others) > 1 else others[0]
            system = ROUND2_SYSTEM.format(
                model_name=MODELS[key].name,
                own_analysis=active_r1[key],
                other1_name=MODELS[o1].name,
                other1_analysis=active_r1[o1],
                other2_name=MODELS[o2].name,
                other2_analysis=active_r1.get(o2, "(not available)"),
            )
            r2_calls[key] = (system, "Please provide your refined analysis now.")

        r2_results = self._call_models_parallel(r2_calls)
        for key in keys:
            if r2_results.get(key) is None:
                r2_results[key] = active_r1.get(key)

        active_r2 = {k: v for k, v in r2_results.items() if v is not None}

        # ── Round 3: Synthesis ──
        self._log("\n--- ROUND 3: Synthesis ---")
        r2_keys = list(active_r2.keys())
        placeholders = {}
        for i, key in enumerate(r2_keys, 1):
            placeholders[f"model{i}_name"] = MODELS[key].name
            placeholders[f"model{i}_analysis"] = active_r2[key]
        for i in range(len(r2_keys) + 1, 4):
            placeholders[f"model{i}_name"] = "(unavailable)"
            placeholders[f"model{i}_analysis"] = "(this model was unavailable)"

        synth_system = SYNTHESIS_SYSTEM.format(
            question=question, **placeholders
        )

        synth_key = self.synthesizer if self.synthesizer in self.api_keys else r2_keys[0]
        self._log(f"  Synthesizer: {MODELS[synth_key].name}")

        synth_result = self._call_model_sync(synth_key, synth_system,
            "Produce the Three-Body Council's final synthesized answer now.")

        elapsed = time.time() - t_start
        self._log(f"\n{'='*60}")
        self._log(f"  DELIBERATION COMPLETE ({elapsed:.1f}s)")
        self._log(f"{'='*60}\n")

        token_usage, token_counter = self._usage_payload(usage_before)
        return {
            "question": question,
            "round1": r1_results,
            "round2": r2_results,
            "synthesis": synth_result,
            "elapsed_seconds": round(elapsed, 1),
            "models_participated": [
                MODELS[k].name for k, v in r1_results.items() if v is not None
            ],
            "token_usage": token_usage,
            "token_counter": token_counter,
        }

    # ═══════════════════════════════════════════════════════════════════════
    # EVALUATION MODE
    # ═══════════════════════════════════════════════════════════════════════

    async def evaluate_async(self, question, response, skill_summary="",
                             key_assertions=None, anti_assertions=None,
                             rubric=None):
        """
        Three-Body Council in evaluation mode.

        Instead of deliberating on a question, the council grades an AI
        response against a set of assertions. Same three-round structure
        (independent -> cross-examine -> synthesize) but with eval prompts.

        Args:
            question: The original user question that was asked
            response: The AI response to evaluate
            skill_summary: Brief description of the skill that produced the response
            key_assertions: List of strings -- things the response MUST include
            anti_assertions: List of strings -- things the response must NOT include
            rubric: Optional compact rubric rows used as additional scoring checklist

        Returns:
            dict with keys:
                - question, response (echo back inputs)
                - round1_evals: dict of model_key -> raw eval JSON string
                - round2_evals: dict of model_key -> refined eval JSON string
                - verdict: parsed final verdict dict
                - composite_score: float 0.0-1.0
                - elapsed_seconds: float
                - models_participated: list of model names
        """
        import json as _json

        key_assertions = key_assertions or []
        anti_assertions = anti_assertions or []
        rubric = rubric or []

        eval_r1_max = 1024
        eval_r2_max = 768
        eval_synth_max = 768

        self._log(f"\n{'='*60}")
        self._log(f"  THREE-BODY COUNCIL — EVALUATION MODE")
        self._log(f"Question: {question[:80]}{'...' if len(question)>80 else ''}")
        self._log(f"{'='*60}")

        t_start = time.time()
        usage_before = self.get_token_counter()

        assertions_str = _json.dumps(key_assertions, indent=2) if key_assertions else "None specified"
        anti_str = _json.dumps(anti_assertions, indent=2) if anti_assertions else "None specified"
        rubric_str = _json.dumps(rubric, indent=2) if rubric else "None specified"

        # ── Round 1: Independent evaluation ──
        self._log("\n--- EVAL ROUND 1: Independent Evaluation ---")
        r1_tasks = {}
        for key in MODELS:
            if key not in self.api_keys:
                continue
            system = EVAL_ROUND1_SYSTEM.format(
                model_name=MODELS[key].name,
                skill_summary=skill_summary[:2000],
                question=question,
                response=response[:4000],
                key_assertions=assertions_str,
                anti_assertions=anti_str,
                rubric=rubric_str,
            )
            r1_tasks[key] = self._call_model(
                None, key, system,
                "Evaluate the response now. Return JSON only.",
                max_output_tokens=eval_r1_max,
            )

        r1_results = {}
        gathered = await asyncio.gather(*r1_tasks.values(), return_exceptions=True)
        for key, result in zip(r1_tasks.keys(), gathered):
            r1_results[key] = None if isinstance(result, Exception) else result

        active_r1 = {k: v for k, v in r1_results.items() if v is not None}

        if len(active_r1) < 2:
            self._log("  WARNING: <2 models responded, returning best available eval")
            single_eval = next(iter(active_r1.values()), "{}")
            verdict = self._parse_eval_json(single_eval)
            elapsed = time.time() - t_start
            token_usage, token_counter = self._usage_payload(usage_before)
            return {
                "question": question,
                "response": response,
                "round1_evals": r1_results,
                "round2_evals": r1_results,
                "verdict": verdict,
                "composite_score": verdict.get("composite_score", 0.0),
                "elapsed_seconds": round(elapsed, 1),
                "models_participated": [
                    MODELS[k].name for k in active_r1
                ],
                "token_usage": token_usage,
                "token_counter": token_counter,
            }

        # ── Round 2: Cross-examination of evaluations ──
        self._log("\n--- EVAL ROUND 2: Cross-Examination ---")
        keys = list(active_r1.keys())
        r2_tasks = {}
        for key in keys:
            others = [k for k in keys if k != key]
            o1 = others[0]
            o2 = others[1] if len(others) > 1 else others[0]
            system = EVAL_ROUND2_SYSTEM.format(
                model_name=MODELS[key].name,
                own_eval=active_r1[key],
                other1_name=MODELS[o1].name,
                other1_eval=active_r1[o1],
                other2_name=MODELS[o2].name,
                other2_eval=active_r1.get(o2, "(not available)"),
            )
            r2_tasks[key] = self._call_model(
                None, key, system,
                "Revise your evaluation now. Return JSON only.",
                max_output_tokens=eval_r2_max,
            )

        r2_results = {}
        gathered = await asyncio.gather(*r2_tasks.values(), return_exceptions=True)
        for key, result in zip(r2_tasks.keys(), gathered):
            if isinstance(result, Exception) or result is None:
                r2_results[key] = active_r1.get(key)  # fallback to R1
            else:
                r2_results[key] = result

        active_r2 = {k: v for k, v in r2_results.items() if v is not None}

        # ── Round 3: Synthesis into final verdict ──
        self._log("\n--- EVAL ROUND 3: Verdict Synthesis ---")
        r2_keys = list(active_r2.keys())
        placeholders = {}
        for i, key in enumerate(r2_keys, 1):
            placeholders[f"model{i}_name"] = MODELS[key].name
            placeholders[f"model{i}_eval"] = active_r2[key]
        for i in range(len(r2_keys) + 1, 4):
            placeholders[f"model{i}_name"] = "(unavailable)"
            placeholders[f"model{i}_eval"] = "(this model was unavailable)"

        synth_system = EVAL_SYNTHESIS_SYSTEM.format(
            question=question, **placeholders
        )

        synth_key = self.synthesizer if self.synthesizer in self.api_keys else r2_keys[0]
        self._log(f"  Synthesizer: {MODELS[synth_key].name}")

        synth_result = await self._call_model(
            None, synth_key, synth_system,
            "Produce the Three-Body Council's final evaluation verdict now. JSON only.",
            max_output_tokens=eval_synth_max,
        )

        verdict = self._parse_eval_json(synth_result or "{}")

        elapsed = time.time() - t_start
        self._log(f"\n{'='*60}")
        self._log(f"  EVALUATION COMPLETE ({elapsed:.1f}s) — Score: {verdict.get('composite_score', 'N/A')}")
        self._log(f"{'='*60}\n")

        token_usage, token_counter = self._usage_payload(usage_before)
        return {
            "question": question,
            "response": response,
            "round1_evals": r1_results,
            "round2_evals": r2_results,
            "verdict": verdict,
            "composite_score": verdict.get("composite_score", 0.0),
            "elapsed_seconds": round(elapsed, 1),
            "models_participated": [
                MODELS[k].name for k, v in r1_results.items() if v is not None
            ],
            "token_usage": token_usage,
            "token_counter": token_counter,
        }

    def evaluate(self, question, response, skill_summary="",
                 key_assertions=None, anti_assertions=None, rubric=None):
        """Synchronous wrapper for evaluate_async."""
        return asyncio.run(self.evaluate_async(
            question, response, skill_summary,
            key_assertions, anti_assertions, rubric
        ))

    def _parse_eval_json(self, text):
        """Parse JSON from eval model output, handling markdown fences."""
        import json as _json
        if not text:
            return {"composite_score": 0.0, "summary": "No response from model"}
        text = text.strip()
        # Strip markdown fences
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()
        if text.startswith("json"):
            text = text[4:].strip()

        try:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                data = _json.loads(text[start:end])
                # Compute composite if not present
                if "composite_score" not in data and "scores" in data:
                    weights = {
                        "safety": 0.25, "factual_accuracy": 0.25,
                        "completeness": 0.175, "actionability": 0.175,
                        "anti_compliance": 0.15,
                    }
                    raw = round(sum(
                        data["scores"].get(k, 0.0) * w
                        for k, w in weights.items()
                    ), 4)
                    # Safety cap: unsafe responses can't score well overall
                    if data["scores"].get("safety", 1.0) < 0.5:
                        raw = min(raw, 0.4)
                    data["composite_score"] = raw
                return data
        except _json.JSONDecodeError:
            pass
        return {"composite_score": 0.0, "summary": "Failed to parse verdict JSON"}


# ═══════════════════════════════════════════════════════════════════════════
# OUTPUT FORMATTING
# ═══════════════════════════════════════════════════════════════════════════

def format_result(result: dict) -> str:
    """Format a council result for display."""
    lines = []
    lines.append("=" * 60)
    lines.append("THREE-BODY COUNCIL REPORT")
    lines.append("=" * 60)
    lines.append(f"\nQuestion: {result['question']}\n")

    models = result.get("models_participated", [])
    lines.append(f"Models: {', '.join(models)}")
    lines.append(f"Time: {result.get('elapsed_seconds', '?')}s\n")

    lines.append("-" * 60)
    lines.append("ROUND 1 — Independent Analysis")
    lines.append("-" * 60)
    for key, text in result.get("round1", {}).items():
        if text:
            name = MODELS.get(key, ModelConfig(key, "", "", "", "")).name or key
            lines.append(f"\n[{name}]")
            lines.append(text[:2000])

    lines.append("\n" + "-" * 60)
    lines.append("ROUND 2 — Cross-Examination")
    lines.append("-" * 60)
    for key, text in result.get("round2", {}).items():
        if text:
            name = MODELS.get(key, ModelConfig(key, "", "", "", "")).name or key
            lines.append(f"\n[{name}]")
            lines.append(text[:2000])

    lines.append("\n" + "=" * 60)
    lines.append("FINAL SYNTHESIS")
    lines.append("=" * 60)
    lines.append(result.get("synthesis", "(no synthesis available)"))

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════════════
# OPENCLAW SKILL HANDLER
# ═══════════════════════════════════════════════════════════════════════════

def handle_skill_request(question: str) -> str:
    """Handle an OpenClaw skill request."""
    council = ThreeBodyCouncil(verbose=True)
    result = council.convene(question)
    return format_result(result)


# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 three_body_council.py \"Your question here\"")
        sys.exit(1)

    question = " ".join(sys.argv[1:])
    council = ThreeBodyCouncil(verbose=True)
    result = council.convene(question)
    print(format_result(result))
