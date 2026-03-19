"""
Path resolution helpers for AutoImprove runtime.
Finds the skills directory via env var or auto-discovery.
"""

import os
from pathlib import Path


def resolve_skills_dir(self_dir: Path) -> Path:
    """Resolve the canonical skills directory."""
    # 1. Explicit env var override
    override = os.environ.get("OPENCLAW_SKILLS_DIR", "").strip()
    if not override:
        override = os.environ.get("OPENCLAW_SKILLS_DIR", "").strip()
    if override:
        candidate = Path(override).expanduser()
        if candidate.exists():
            return candidate

    # 2. Auto-discover: this skill lives at <skills_dir>/autoimprove-tbc/,
    #    so the parent is the skills directory.
    if self_dir.parent.exists():
        return self_dir.parent

    return self_dir


def resolve_autoimprove_dir(self_dir: Path) -> Path:
    """Resolve the autoimprove directory under the canonical skills root."""
    skills_dir = resolve_skills_dir(self_dir)
    candidate = skills_dir / "autoimprove-tbc"
    if candidate.exists():
        return candidate
    return self_dir


def resolve_three_body_dir(self_dir: Path) -> Path:
    """Resolve three-body-council directory under the canonical skills root."""
    skills_dir = resolve_skills_dir(self_dir)
    candidate = skills_dir / "three-body-council"
    if candidate.exists():
        return candidate
    raise FileNotFoundError(f"three-body-council skill not found at {candidate}")
