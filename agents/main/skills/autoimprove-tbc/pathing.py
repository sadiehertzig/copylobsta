"""
Path resolution helpers for AutoImprove runtime.
Finds the skills directory via env var or auto-discovery.
"""

import os
from pathlib import Path


def _resolve_or_none(path: Path) -> Path | None:
    try:
        return path.expanduser().resolve(strict=True)
    except Exception:
        return None


def resolve_skills_dir(self_dir: Path) -> Path:
    """Resolve the canonical skills directory."""
    override = os.environ.get("OPENCLAW_SKILLS_DIR", "").strip()
    if override:
        candidate = _resolve_or_none(Path(override))
        if candidate and candidate.is_dir():
            return candidate

    # Auto-discover: this skill lives at <skills_dir>/autoimprove-tbc/
    parent = _resolve_or_none(self_dir.parent)
    if parent and parent.is_dir():
        return parent

    return self_dir.resolve()


def resolve_autoimprove_dir(self_dir: Path) -> Path:
    """Resolve the autoimprove directory under the canonical skills root."""
    skills_dir = resolve_skills_dir(self_dir)
    candidate = skills_dir / "autoimprove-tbc"
    resolved = _resolve_or_none(candidate)
    if resolved and resolved.is_dir():
        return resolved
    return self_dir.resolve()


def resolve_three_body_dir(self_dir: Path) -> Path:
    """Resolve three-body-council directory under the canonical skills root."""
    skills_dir = resolve_skills_dir(self_dir)
    candidate = skills_dir / "three-body-council"
    resolved = _resolve_or_none(candidate)
    if resolved and resolved.is_dir():
        return resolved
    raise FileNotFoundError(f"three-body-council skill not found at {candidate}")
