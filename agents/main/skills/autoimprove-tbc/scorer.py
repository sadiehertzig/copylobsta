"""
AutoImprove scorer and ratchet.
Weighted scoring with tier/difficulty multipliers.
Git-based keep/discard for the improvement loop.
"""

import subprocess
from pathlib import Path
from models import TestCase, Verdict, AutoImproveConfig


class Scorer:
    """Computes weighted aggregate scores from verdicts."""

    TIER_WEIGHTS = {"curated": 3.0, "generated": 1.0, "candidate": 0.5}
    DIFFICULTY_MULT = {"easy": 1.0, "medium": 1.0, "hard": 1.5, "adversarial": 2.0}

    def per_question_scores(self, verdicts: list) -> dict:
        """Extract {test_id: composite_score} from a list of Verdicts."""
        return {v.test_id: v.composite_score for v in verdicts}

    def weighted_mean(self, scores: dict, test_bank: list) -> float:
        """Compute tier- and difficulty-weighted aggregate score."""
        tc_map = {tc.id: tc for tc in test_bank}
        total_w = 0.0
        w_sum = 0.0
        for tid, score in scores.items():
            tc = tc_map.get(tid)
            if not tc:
                continue
            w = self.TIER_WEIGHTS.get(tc.tier, 1.0)
            w *= self.DIFFICULTY_MULT.get(tc.difficulty, 1.0)
            w_sum += score * w
            total_w += w
        return w_sum / total_w if total_w > 0 else 0.0

    def find_worst(self, scores: dict, n: int = 5) -> list:
        """Return the n lowest-scoring (test_id, score) tuples."""
        return sorted(scores.items(), key=lambda x: x[1])[:n]


class Ratchet:
    """Git-based keep/discard logic for the improvement loop."""

    def __init__(self, repo_path: str = "", skill_path: str = ""):
        self.repo_path = repo_path
        self.skill_path = skill_path

    def _rel_skill_path(self) -> str:
        """Return the skill file path relative to the repo root."""
        if not self.repo_path or not self.skill_path:
            return ""
        try:
            return str(Path(self.skill_path).relative_to(self.repo_path))
        except ValueError:
            return self.skill_path

    def should_keep(self, before_scores: dict, after_scores: dict,
                    before_verdicts: list, after_verdicts: list,
                    test_bank: list, config: AutoImproveConfig,
                    scorer: Scorer) -> tuple:
        """
        Decide whether to keep a skill file edit.
        Returns (keep: bool, reason: str).

        Rules:
        1. Aggregate score must improve
        2. No curated question may regress beyond threshold
        3. No new safety flags
        4. Improvement must exceed minimum threshold
        """
        agg_before = scorer.weighted_mean(before_scores, test_bank)
        agg_after = scorer.weighted_mean(after_scores, test_bank)

        # Rule 1
        if agg_after <= agg_before:
            return False, "no_improvement"

        # Rule 2: protect curated and adversarial tests from regression
        protected_ids = {
            tc.id for tc in test_bank
            if tc.tier == "curated" or tc.difficulty == "adversarial"
        }
        for tid in protected_ids:
            b = before_scores.get(tid)
            a = after_scores.get(tid)
            if b is not None and a is not None:
                if b - a > config.regression_threshold:
                    tc = {t.id: t for t in test_bank}.get(tid)
                    label = "curated" if tc and tc.tier == "curated" else "adversarial"
                    return False, f"{label}_regression_{tid}"

        # Rule 3
        before_safety = {v.test_id for v in before_verdicts if v.has_safety_flag}
        after_safety = {v.test_id for v in after_verdicts if v.has_safety_flag}
        new_safety = after_safety - before_safety
        if new_safety:
            return False, f"new_safety_{next(iter(new_safety))}"

        # Rule 4
        if agg_after - agg_before < config.min_improvement:
            return False, "below_min_improvement"

        return True, "improved"

    def setup_branch(self):
        if self.repo_path:
            self._git("checkout", "-B", "feature/autoimprove-tbc", "main")

    def commit(self, msg: str):
        if self.repo_path:
            rel = self._rel_skill_path()
            if rel:
                self._git("add", rel)
            else:
                self._git("add", ".")
            self._git("commit", "-m", f"autoimprove: {msg}")

    def revert(self):
        if self.repo_path:
            rel = self._rel_skill_path()
            if rel:
                self._git("checkout", "--", rel)
            else:
                self._git("checkout", "--", ".")

    def push(self):
        if self.repo_path:
            self._git("push", "-f", "origin", "feature/autoimprove-tbc")

    def _git(self, *args):
        subprocess.run(
            ["git"] + list(args),
            cwd=self.repo_path, capture_output=True, text=True,
        )
