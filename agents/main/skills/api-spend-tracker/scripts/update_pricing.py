#!/usr/bin/env python3
"""
Weekly pricing auto-updater for the API Spend Tracker.

Fetches current pricing from provider documentation pages, uses Claude Haiku
to extract structured pricing data, validates it, and updates cost_tables.py.
Sends a Telegram notification with any changes.

Cron target: runs weekly (e.g., every Sunday at 6am ET).
Manual run:  python3 update_pricing.py [--dry-run]
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

import requests

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.expanduser("~/.openclaw/.env"))
except ImportError:
    pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
COST_TABLES_PATH = os.path.join(SCRIPT_DIR, "cost_tables.py")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
TELEGRAM_BOT_TOKEN = os.environ.get("OPENCLAW_TELEGRAM_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("OPENCLAW_TELEGRAM_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")

# Provider pricing page URLs
PRICING_URLS = {
    "anthropic": "https://docs.anthropic.com/en/docs/about-claude/models",
    # OpenAI blocks all scraping of their pricing page — must be updated manually
    # "openai": "https://platform.openai.com/docs/pricing",
    "google": "https://ai.google.dev/gemini-api/docs/pricing",
}

# Models we care about (to focus the extraction)
TRACKED_MODELS = {
    "anthropic": [
        "claude-opus-4", "claude-sonnet-4", "claude-haiku-4",
    ],
    "openai": [
        "gpt-4o", "gpt-4.1", "o3", "o4-mini",
    ],
    "google": [
        "gemini-2.5", "gemini-2.0",
    ],
}

MODEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


def fetch_page_text(url: str) -> str:
    """Fetch a URL and return its text content, stripping HTML tags."""
    resp = requests.get(url, timeout=30, headers={
        "User-Agent": "Mozilla/5.0 (compatible; OpenClawPricingBot/1.0)"
    })
    resp.raise_for_status()
    text = resp.text
    # Strip HTML tags to get readable text
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    # Truncate to ~15k chars to fit in context
    return text[:15000]


def extract_pricing_with_llm(provider: str, page_text: str) -> dict | None:
    """Use Claude Haiku to extract structured pricing from page text."""
    if not ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY not set, cannot extract pricing", file=sys.stderr)
        return None

    model_hints = ", ".join(TRACKED_MODELS.get(provider, []))

    prompt = f"""Extract API pricing for {provider} models from this documentation page text.

I need pricing for these model families: {model_hints}

Return ONLY a JSON object mapping model ID strings to pricing objects.
Each pricing object must have exactly these keys (all values in USD per 1 million tokens):
- "input": input token price
- "output": output token price
- "cache_read": cached/prompt cache read price (use 0 ONLY if the page explicitly does not mention caching for that model)
- "cache_write": cache write/creation price (use 0 ONLY if the page explicitly does not mention caching for that model)

IMPORTANT:
- Use the exact API model ID strings (e.g., "claude-sonnet-4-20250514" not "Claude Sonnet 4").
- Include version-dated IDs where shown, plus any shorthand aliases.
- Only include models where you can find clear pricing numbers on the page.
- For cache pricing: many providers list "prompt caching" prices separately. Look for terms like "cache read", "cache write", "cached input", "prompt caching", "cache creation". If these are listed, include them.

Page text:
{page_text}

Respond with ONLY the JSON object, no markdown fences, no explanation."""

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 2048,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        text = data["content"][0]["text"].strip()

        # Log the Haiku call cost to the spend tracker
        usage = data.get("usage", {})
        try:
            from usage_logger import log_usage
            log_usage(
                provider="anthropic",
                api_key_label="pricing-updater",
                model="claude-haiku-4-5-20251001",
                input_tokens=usage.get("input_tokens", 0),
                output_tokens=usage.get("output_tokens", 0),
                cache_read_tokens=usage.get("cache_read_input_tokens", 0) or 0,
                cache_write_tokens=usage.get("cache_creation_input_tokens", 0) or 0,
            )
        except Exception:
            pass

        # Parse JSON from response (handle markdown fences if present)
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
        return json.loads(text)

    except Exception as e:
        print(f"LLM extraction failed for {provider}: {e}", file=sys.stderr)
        return None


def validate_pricing(provider: str, new_pricing: dict, old_pricing: dict) -> tuple[dict, list[str]]:
    """Validate extracted pricing against sanity checks. Returns (validated, warnings)."""
    validated = {}
    warnings = []

    for model_id, rates in new_pricing.items():
        model_token = str(model_id).strip()
        if not MODEL_ID_PATTERN.fullmatch(model_token):
            warnings.append(f"  Skipped {model_id}: invalid model id format")
            continue

        if not isinstance(rates, dict):
            warnings.append(f"  Skipped {model_token}: rates not a dict")
            continue

        required = {"input", "output", "cache_read", "cache_write"}
        if not required.issubset(rates.keys()):
            missing = required - set(rates.keys())
            warnings.append(f"  Skipped {model_token}: missing keys {missing}")
            continue

        # Sanity: all values should be non-negative numbers
        if any(not isinstance(v, (int, float)) or v < 0 for v in rates.values()):
            warnings.append(f"  Skipped {model_token}: invalid price values")
            continue

        # Sanity: output should generally cost >= input
        if rates["output"] < rates["input"] * 0.5:
            warnings.append(f"  Warning {model_token}: output (${rates['output']}) < input (${rates['input']})")

        # Sanity: prices shouldn't be absurdly high (>$500/M tokens)
        if any(v > 500 for v in rates.values()):
            warnings.append(f"  Skipped {model_token}: price >$500/M tokens seems wrong")
            continue

        # Check for large changes vs old pricing (>3x change is suspicious)
        if model_token in old_pricing:
            old = old_pricing[model_token]
            for key in ("input", "output"):
                if old[key] > 0 and rates[key] / old[key] > 3:
                    warnings.append(f"  Warning {model_token}: {key} jumped {old[key]} -> {rates[key]} (>3x)")
                if old[key] > 0 and rates[key] / old[key] < 0.1:
                    warnings.append(f"  Warning {model_token}: {key} dropped {old[key]} -> {rates[key]} (<0.1x)")

        # Preserve existing cache pricing if new data has 0 (likely missing, not free)
        if model_token in old_pricing:
            old = old_pricing[model_token]
            for cache_key in ("cache_read", "cache_write"):
                if rates.get(cache_key, 0) == 0 and old.get(cache_key, 0) > 0:
                    rates[cache_key] = old[cache_key]

        validated[model_token] = {k: float(rates[k]) for k in sorted(required)}

    return validated, warnings


def load_current_pricing() -> dict:
    """Load current pricing from cost_tables.py."""
    # Import the module dynamically
    sys.path.insert(0, SCRIPT_DIR)
    import importlib
    import cost_tables
    importlib.reload(cost_tables)
    return {
        "anthropic": dict(cost_tables.ANTHROPIC_PRICING),
        "openai": dict(cost_tables.OPENAI_PRICING),
        "google": dict(cost_tables.GOOGLE_PRICING),
    }


def diff_pricing(old: dict, new: dict) -> list[str]:
    """Generate human-readable diff of pricing changes."""
    changes = []
    all_models = set(old.keys()) | set(new.keys())
    for model in sorted(all_models):
        if model not in old:
            rates = new[model]
            changes.append(f"  + {model}: in=${rates['input']}, out=${rates['output']}")
        elif model not in new:
            pass  # Don't report removals — we merge, not replace
        else:
            old_rates = old[model]
            new_rates = new[model]
            diffs = []
            for key in ("input", "output", "cache_read", "cache_write"):
                if abs(old_rates.get(key, 0) - new_rates.get(key, 0)) > 0.001:
                    diffs.append(f"{key}: ${old_rates.get(key, 0)} -> ${new_rates[key]}")
            if diffs:
                changes.append(f"  ~ {model}: {', '.join(diffs)}")
    return changes


def write_cost_tables(pricing: dict):
    """Write updated pricing back to cost_tables.py."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def format_dict(d: dict, indent: int = 4) -> str:
        lines = []
        pad = " " * indent
        for model_id in sorted(d.keys()):
            rates = d[model_id]
            parts = ", ".join(f'{json.dumps(k)}: {float(v)}' for k, v in rates.items())
            lines.append(f"{pad}{json.dumps(model_id)}: {{{parts}}},")
        return "\n".join(lines)

    content = f'''"""
Per-model pricing in USD per 1M tokens.
Update this file when providers change pricing.
Last updated: {today}
"""

ANTHROPIC_PRICING = {{
{format_dict(pricing["anthropic"])}
}}

OPENAI_PRICING = {{
{format_dict(pricing["openai"])}
}}

GOOGLE_PRICING = {{
{format_dict(pricing["google"])}
}}

ALL_PRICING = {{
    "anthropic": ANTHROPIC_PRICING,
    "openai": OPENAI_PRICING,
    "google": GOOGLE_PRICING,
}}


def calculate_cost(
    provider: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float:
    """Calculate cost in USD for a single API call."""
    pricing = ALL_PRICING.get(provider, {{}})
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
'''
    with open(COST_TABLES_PATH, "w") as f:
        f.write(content)


def send_notification(message: str):
    """Send update notification via Telegram."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": message},
            timeout=15,
        )
    except Exception:
        pass


def run_update(dry_run: bool = False):
    """Main entry point — fetch, extract, validate, update."""
    current = load_current_pricing()
    updated = {k: dict(v) for k, v in current.items()}  # Deep copy
    all_changes = []
    all_warnings = []
    failures = []

    for provider, url in PRICING_URLS.items():
        print(f"\n--- {provider} ---")
        print(f"Fetching {url}...")

        try:
            page_text = fetch_page_text(url)
            print(f"  Got {len(page_text)} chars")
        except Exception as e:
            print(f"  FAILED to fetch: {e}")
            failures.append(f"{provider}: fetch failed ({e})")
            continue

        print("  Extracting pricing with Claude Haiku...")
        extracted = extract_pricing_with_llm(provider, page_text)
        if not extracted:
            failures.append(f"{provider}: LLM extraction failed")
            continue

        print(f"  Extracted {len(extracted)} models")
        validated, warnings = validate_pricing(provider, extracted, current.get(provider, {}))
        all_warnings.extend(warnings)
        for w in warnings:
            print(w)

        if validated:
            changes = diff_pricing(current.get(provider, {}), validated)
            all_changes.extend(changes)
            # Merge: keep existing models, update/add new ones
            updated[provider].update(validated)
            print(f"  Validated {len(validated)} models, {len(changes)} changes")
        else:
            print("  No valid pricing extracted")
            failures.append(f"{provider}: no valid pricing after validation")

    # Summary
    print(f"\n{'=' * 40}")
    if all_changes:
        print("CHANGES:")
        for c in all_changes:
            print(c)
    else:
        print("No pricing changes detected.")

    if all_warnings:
        print("\nWARNINGS:")
        for w in all_warnings:
            print(w)

    if dry_run:
        print("\n[DRY RUN] No files were modified.")
        return

    if all_changes:
        write_cost_tables(updated)
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        print(f"\nUpdated {COST_TABLES_PATH}")

        # Notify via Telegram
        lines = [f"\U0001f4b0 PRICING UPDATE ({today})"]
        if all_changes:
            lines.append("")
            lines.extend(all_changes)
        if failures:
            lines.append("")
            lines.append("Failed providers: " + ", ".join(failures))
        if all_warnings:
            lines.append("")
            lines.extend(all_warnings[:5])  # Cap warnings
        send_notification("\n".join(lines))
    elif failures:
        send_notification(
            f"\u26a0\ufe0f Pricing update failed for: {', '.join(failures)}\n"
            "Manual check recommended."
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Auto-update API pricing tables")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    args = parser.parse_args()
    run_update(dry_run=args.dry_run)
