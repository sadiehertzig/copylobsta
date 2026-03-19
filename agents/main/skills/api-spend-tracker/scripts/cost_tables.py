"""
Per-model pricing in USD per 1M tokens.
Update this file when providers change pricing.
Last updated: 2026-03-16
"""

ANTHROPIC_PRICING = {
    "claude-opus-4-20250514": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-sonnet-4-20250514": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.00, "cache_read": 0.08, "cache_write": 1.00},
    "claude-opus-4-6": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
}

OPENAI_PRICING = {
    "gpt-4o": {"input": 2.50, "output": 10.00, "cache_read": 1.25, "cache_write": 0},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60, "cache_read": 0.075, "cache_write": 0},
    "gpt-4.1": {"input": 2.00, "output": 8.00, "cache_read": 0.50, "cache_write": 0},
    "gpt-4.1-mini": {"input": 0.40, "output": 1.60, "cache_read": 0.10, "cache_write": 0},
    "gpt-4.1-nano": {"input": 0.10, "output": 0.40, "cache_read": 0.025, "cache_write": 0},
    "o3": {"input": 10.00, "output": 40.00, "cache_read": 2.50, "cache_write": 0},
    "o3-mini": {"input": 1.10, "output": 4.40, "cache_read": 0.275, "cache_write": 0},
    "o4-mini": {"input": 1.10, "output": 4.40, "cache_read": 0.275, "cache_write": 0},
    # Realtime API — priced per token (audio tokens are ~50/sec)
    "gpt-4o-realtime-preview": {"input": 5.00, "output": 20.00, "cache_read": 2.50, "cache_write": 0},
    "gpt-4o-mini-realtime-preview": {"input": 0.60, "output": 2.40, "cache_read": 0.30, "cache_write": 0},
    "gpt-4o-mini-transcribe": {"input": 0.60, "output": 2.40, "cache_read": 0, "cache_write": 0},
}

GOOGLE_PRICING = {
    "gemini-2.5-pro": {"input": 1.25, "output": 10.00, "cache_read": 0.315, "cache_write": 0},
    "gemini-2.5-flash": {"input": 0.15, "output": 0.60, "cache_read": 0.0375, "cache_write": 0},
    "gemini-2.0-flash": {"input": 0.10, "output": 0.40, "cache_read": 0.025, "cache_write": 0},
}

ALL_PRICING = {
    "anthropic": ANTHROPIC_PRICING,
    "openai": OPENAI_PRICING,
    "google": GOOGLE_PRICING,
}


def calculate_cost(
    provider: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float:
    """Calculate cost in USD for a single API call."""
    input_tokens = max(0, input_tokens)
    output_tokens = max(0, output_tokens)
    cache_read_tokens = max(0, cache_read_tokens)
    cache_write_tokens = max(0, cache_write_tokens)
    pricing = ALL_PRICING.get(provider, {})
    rates = pricing.get(model)
    if not rates:
        for key in pricing:
            if model.startswith(key):
                rates = pricing[key]
                break
    if not rates:
        return 0.0
    cost = (
        (input_tokens * rates["input"] / 1_000_000)
        + (output_tokens * rates["output"] / 1_000_000)
        + (cache_read_tokens * rates.get("cache_read", 0) / 1_000_000)
        + (cache_write_tokens * rates.get("cache_write", 0) / 1_000_000)
    )
    return round(cost, 6)
