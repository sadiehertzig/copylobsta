"""
Tool executor for AutoImprove.
Provides Gemini-backed web_search and HTTP web_fetch implementations.
"""

import json
import os

import httpx

from api_utils import GEMINI_SEARCH_TOOL_OPTIONS, send_with_retries
from spend_tracker import log_usage as log_spend_usage


FETCH_MAX_CHARS = 15_000
FETCH_TIMEOUT = 30.0
SEARCH_TIMEOUT = 60.0

GEMINI_MODEL = "gemini-3.1-pro-preview"
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)


async def web_search(query: str, count: int = 10) -> dict:
    """Search the web using Gemini grounding."""
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"error": "No GEMINI_API_KEY set", "results": []}

    try:
        count = int(count or 10)
    except (TypeError, ValueError):
        count = 10
    count = max(1, min(count, 10))

    prompt = (
        "Use web search and return only a JSON array of result objects "
        "with keys: title, url, snippet.\n\n"
        f"Query: {query}\n"
        f"Result count: {count}\n"
        "JSON only."
    )

    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }

    base_body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.1},
    }

    last_error = "Gemini search failed"
    async with httpx.AsyncClient() as client:
        for tools in GEMINI_SEARCH_TOOL_OPTIONS + [None]:
            body = dict(base_body)
            if tools is not None:
                body["tools"] = tools

            try:
                resp = await send_with_retries(
                    client,
                    "POST",
                    GEMINI_URL,
                    headers=headers,
                    json=body,
                    timeout=SEARCH_TIMEOUT,
                    max_attempts=4,
                    component="tool_executor.web_search",
                )
            except Exception as e:
                last_error = str(e)
                continue

            payload = resp.json()
            log_spend_usage(
                provider="google",
                api_key_label="autoimprove-tool-executor",
                model=GEMINI_MODEL,
                usage=payload.get("usageMetadata", {}),
            )
            results = _extract_results(payload, count)
            if results:
                return {"results": results}
            last_error = "Gemini returned no search results"

    return {"error": last_error, "results": []}


def _extract_results(payload: dict, count: int) -> list:
    text = _extract_text(payload)
    parsed = _parse_json_array(text)
    normalized = _normalize_results(parsed, count)
    if normalized:
        return normalized
    return _extract_grounding_results(payload, count)


def _extract_text(payload: dict) -> str:
    candidates = payload.get("candidates", [])
    if not candidates:
        return ""
    parts = candidates[0].get("content", {}).get("parts", [])
    chunks = [p.get("text", "") for p in parts if isinstance(p, dict) and "text" in p]
    return "\n".join(chunks).strip()


def _parse_json_array(text: str) -> list:
    if not text:
        return []
    cleaned = text.strip()
    if "```" in cleaned:
        cleaned = cleaned.split("```", 1)[-1]
        cleaned = cleaned.rsplit("```", 1)[0]
    cleaned = cleaned.strip()
    if cleaned.startswith("json"):
        cleaned = cleaned[4:].strip()
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    start = cleaned.find("[")
    end = cleaned.rfind("]") + 1
    if start >= 0 and end > start:
        try:
            parsed = json.loads(cleaned[start:end])
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            return []
    return []


def _normalize_results(items: list, count: int) -> list:
    out = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or item.get("link") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        title = str(item.get("title") or item.get("name") or url).strip()
        snippet = str(
            item.get("snippet")
            or item.get("summary")
            or item.get("description")
            or ""
        ).strip()
        out.append({
            "title": title[:200],
            "url": url[:1000],
            "snippet": snippet[:500],
        })
        if len(out) >= count:
            break
    return out


def _extract_grounding_results(payload: dict, count: int) -> list:
    candidates = payload.get("candidates", [])
    if not candidates:
        return []
    grounding = candidates[0].get("groundingMetadata", {})
    chunks = grounding.get("groundingChunks", [])
    out = []
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
        title = str(web.get("title") or url).strip()
        out.append({
            "title": title[:200],
            "url": url[:1000],
            "snippet": "",
        })
        if len(out) >= count:
            break
    return out


async def web_fetch(url: str) -> dict:
    """Fetch a web page and return its text content."""
    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await send_with_retries(
                client,
                "GET",
                url,
                headers={"User-Agent": "OpenClaw-AutoImprove/1.0"},
                timeout=FETCH_TIMEOUT,
                max_attempts=3,
                component="tool_executor.web_fetch",
            )
            text = resp.text[:FETCH_MAX_CHARS]
        return {"url": url, "content": text, "status": resp.status_code}
    except Exception as e:
        return {"url": url, "error": str(e), "content": "", "status": 0}


TOOL_REGISTRY = {
    "web_search": web_search,
    "web_fetch": web_fetch,
}
