"""
Security and filesystem helpers for AutoImprove-TBC.
"""

import json
import os
import tempfile
from pathlib import Path


def clamp_int(value: int, lower: int, upper: int) -> int:
    return max(lower, min(upper, int(value)))


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        dir=str(path.parent),
        delete=False,
        encoding="utf-8",
    ) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def atomic_write_json(path: Path, payload) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2))


def _resolve_or_none(path: Path) -> Path | None:
    try:
        return path.expanduser().resolve(strict=True)
    except Exception:
        return None


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_existing_path(
    candidate: str | Path,
    allowed_roots: list[Path],
    allowed_suffixes: tuple[str, ...] = (),
) -> Path | None:
    resolved = _resolve_or_none(Path(candidate))
    if resolved is None:
        return None
    if allowed_suffixes and resolved.suffix.lower() not in allowed_suffixes:
        return None
    for root in allowed_roots:
        resolved_root = _resolve_or_none(root)
        if resolved_root and is_within(resolved, resolved_root):
            return resolved
    return None
