"""
Shared API helpers for AutoImprove.
Provides retry/backoff wrappers for transient HTTP failures.
"""

import asyncio
import random
from typing import Iterable

import httpx


DEFAULT_RETRY_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}

GEMINI_SEARCH_TOOL_OPTIONS = [
    [{"googleSearch": {}}],
    [{"google_search": {}}],
    [{"googleSearchRetrieval": {}}],
    [{"google_search_retrieval": {}}],
]


def _retry_after_seconds(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After", "").strip()
    if not value:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return max(0.0, parsed)


def _compute_backoff(
    attempt: int,
    response: httpx.Response | None,
    base_delay: float,
    max_delay: float,
    jitter: float,
) -> float:
    if response is not None:
        retry_after = _retry_after_seconds(response)
        if retry_after is not None:
            return min(max_delay, retry_after + random.uniform(0.0, jitter))
    return min(max_delay, base_delay * (2 ** attempt) + random.uniform(0.0, jitter))


async def send_with_retries(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    json: dict | None = None,
    data: dict | None = None,
    timeout: float = 60.0,
    max_attempts: int = 4,
    base_delay: float = 1.0,
    max_delay: float = 20.0,
    jitter: float = 0.3,
    retry_status_codes: Iterable[int] | None = None,
    component: str = "api",
) -> httpx.Response:
    """Send an HTTP request with retry/backoff for transient failures."""
    retry_codes = set(retry_status_codes or DEFAULT_RETRY_STATUS_CODES)
    last_error: Exception | None = None

    for attempt in range(max_attempts):
        response = None
        try:
            response = await client.request(
                method=method,
                url=url,
                headers=headers,
                json=json,
                data=data,
                timeout=timeout,
            )
        except (httpx.TimeoutException, httpx.TransportError, httpx.RequestError) as exc:
            last_error = exc
            if attempt >= max_attempts - 1:
                break
            delay = _compute_backoff(attempt, None, base_delay, max_delay, jitter)
            await asyncio.sleep(delay)
            continue

        if response.status_code < 400:
            return response

        body = response.text[:300].replace("\n", " ").strip()
        if response.status_code in retry_codes and attempt < max_attempts - 1:
            delay = _compute_backoff(attempt, response, base_delay, max_delay, jitter)
            await asyncio.sleep(delay)
            continue

        raise RuntimeError(
            f"{component} request failed with HTTP {response.status_code}: {body}"
        )

    if last_error is not None:
        raise RuntimeError(f"{component} transport error: {last_error}")
    raise RuntimeError(f"{component} request failed after {max_attempts} attempts")
