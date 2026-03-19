"""
OpenClaw Integration — auto-log every LLM API call to the spend tracker.

Option A: Decorator — wrap individual call functions
Option B: Monkey-patch — one line at client init, every call auto-logged
"""

import functools
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from usage_logger import log_anthropic, log_openai, log_google


def _wrap_with_logger(func, logger, api_key_label: str):
    if asyncio.iscoroutinefunction(func):
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            response = await func(*args, **kwargs)
            try:
                logger(response, api_key_label=api_key_label)
            except Exception:
                pass
            return response

        return async_wrapper

    @functools.wraps(func)
    def sync_wrapper(*args, **kwargs):
        response = func(*args, **kwargs)
        try:
            logger(response, api_key_label=api_key_label)
        except Exception:
            pass
        return response

    return sync_wrapper


# ─── Option A: Decorator Pattern ──────────────────────────────────────

def track_anthropic(api_key_label: str = "default"):
    def decorator(func):
        return _wrap_with_logger(func, log_anthropic, api_key_label)
    return decorator


def track_openai(api_key_label: str = "default"):
    def decorator(func):
        return _wrap_with_logger(func, log_openai, api_key_label)
    return decorator


def track_google(api_key_label: str = "default"):
    def decorator(func):
        return _wrap_with_logger(func, log_google, api_key_label)
    return decorator


# ─── Option B: Monkey-Patch at Startup ────────────────────────────────

def patch_anthropic_client(client, api_key_label: str = "default"):
    """
    Monkey-patch an Anthropic client to auto-log all messages.create() calls.

    Usage:
        from anthropic import Anthropic
        client = Anthropic()
        patch_anthropic_client(client, api_key_label="main")
    """
    client.messages.create = _wrap_with_logger(
        client.messages.create,
        log_anthropic,
        api_key_label,
    )
    return client


def patch_openai_client(client, api_key_label: str = "default"):
    """
    Monkey-patch OpenAI clients to auto-log both Responses and Chat Completions calls.
    """
    if hasattr(client, "responses") and hasattr(client.responses, "create"):
        client.responses.create = _wrap_with_logger(
            client.responses.create,
            log_openai,
            api_key_label,
        )

    if hasattr(client, "chat") and hasattr(client.chat, "completions"):
        if hasattr(client.chat.completions, "create"):
            client.chat.completions.create = _wrap_with_logger(
                client.chat.completions.create,
                log_openai,
                api_key_label,
            )

    return client


def patch_google_client(client, api_key_label: str = "default", model: str = "gemini-2.5-flash"):
    """
    Monkey-patch Google GenAI client models.generate_content() calls.
    """
    if not hasattr(client, "models") or not hasattr(client.models, "generate_content"):
        return client

    original = client.models.generate_content
    if asyncio.iscoroutinefunction(original):
        @functools.wraps(original)
        async def async_wrapper(*args, **kwargs):
            response = await original(*args, **kwargs)
            try:
                log_google(response, api_key_label=api_key_label, model=model)
            except Exception:
                pass
            return response

        client.models.generate_content = async_wrapper
        return client

    @functools.wraps(original)
    def sync_wrapper(*args, **kwargs):
        response = original(*args, **kwargs)
        try:
            log_google(response, api_key_label=api_key_label, model=model)
        except Exception:
            pass
        return response

    client.models.generate_content = sync_wrapper
    return client
