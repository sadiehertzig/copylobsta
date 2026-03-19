"""
Optional spend tracker bridge for AutoImprove.
No-ops if api-spend-tracker is unavailable.
"""

from pathlib import Path
import sys


_SELF_DIR = Path(__file__).resolve().parent
_TRACKER_SCRIPTS = _SELF_DIR.parent / "api-spend-tracker" / "scripts"

_LOG_USAGE = None
if _TRACKER_SCRIPTS.exists():
    if str(_TRACKER_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_TRACKER_SCRIPTS))
    try:
        from usage_logger import log_usage as _USAGE_LOG_USAGE

        _LOG_USAGE = _USAGE_LOG_USAGE
    except Exception:
        _LOG_USAGE = None


def _as_int(value) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def log_usage(provider: str, api_key_label: str, model: str, usage: dict | None):
    """Forward usage to api-spend-tracker when available."""
    if not _LOG_USAGE:
        return
    if not provider or not model:
        return

    usage = usage or {}
    input_tokens = _as_int(
        usage.get("input_tokens")
        or usage.get("prompt_tokens")
        or usage.get("promptTokenCount")
    )
    output_tokens = _as_int(
        usage.get("output_tokens")
        or usage.get("completion_tokens")
        or usage.get("candidatesTokenCount")
    )
    cache_read_tokens = _as_int(
        usage.get("cache_read_tokens")
        or usage.get("cache_read_input_tokens")
        or usage.get("cached_content_token_count")
        or usage.get("cachedContentTokenCount")
    )
    cache_write_tokens = _as_int(
        usage.get("cache_write_tokens")
        or usage.get("cache_creation_input_tokens")
    )

    if (
        input_tokens == 0
        and output_tokens == 0
        and cache_read_tokens == 0
        and cache_write_tokens == 0
    ):
        return

    try:
        _LOG_USAGE(
            provider=provider,
            api_key_label=api_key_label or "autoimprove",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
        )
    except Exception:
        pass
