#!/usr/bin/env python3
"""
AutoImprove — Self-Improving Skill Loop for OpenClaw
Orchestrator, CLI, and OpenClaw entry point.

CLI:
    python autoimprove.py interview  --skill /path/to/SKILL.md
    python autoimprove.py generate   --target skill-name
    python autoimprove.py baseline   --target skill-name
    python autoimprove.py run        --target skill-name [--iterations 15]
    python autoimprove.py report     --target skill-name
"""

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

_SELF_DIR = Path(__file__).resolve().parent
if str(_SELF_DIR) not in sys.path:
    sys.path.insert(0, str(_SELF_DIR))
from pathing import resolve_autoimprove_dir, resolve_skills_dir

_SKILLS_DIR = resolve_skills_dir(_SELF_DIR)
_AUTOIMPROVE_DIR = resolve_autoimprove_dir(_SELF_DIR)

# Load API keys from ~/.openclaw/.env if present
_ENV_FILE = Path.home() / ".openclaw" / ".env"
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())

from models import (
    TestCase, Verdict, AutoImproveConfig,
    ResultsLogger, load_test_bank, save_test_bank,
    empty_usage, add_usage,
)
from interview import InterviewEngine
from question_gen import QuestionGenerator
from runner import ResponseRunner
from grader import Grader
from scorer import Scorer, Ratchet
from improver import Improver
from notify import TelegramApproval, apply_approved_skill, discard_proposed_skill

TARGETS_DIR = _AUTOIMPROVE_DIR / "targets"


class AutoImprove:
    """Main orchestrator."""

    def __init__(self, target_name: str, verbose: bool = True):
        self.target_name = target_name
        self.target_dir = TARGETS_DIR / target_name
        self.target_dir.mkdir(parents=True, exist_ok=True)
        (self.target_dir / "verdicts").mkdir(exist_ok=True)

        self.verbose = verbose

        self.runner = ResponseRunner()
        self.scorer = Scorer()
        self.improver = Improver()
        self.logger = ResultsLogger(str(self.target_dir / "results.tsv"))
        self._usage_state = self._load_usage_state()

    def _log(self, msg):
        if self.verbose:
            print(msg, file=sys.stderr)

    @staticmethod
    def _format_edit_history(revert_details: list) -> str:
        """Format rich edit history with revert reasons for the improver."""
        if not revert_details:
            return "None yet."
        lines = []
        for entry in revert_details[-5:]:  # last 5 reverts
            lines.append(
                f"REVERTED: \"{entry['edit']}\" "
                f"({entry['agg_before']} -> {entry['agg_after']}, "
                f"reason: {entry['reason']})"
            )
            if entry.get("regressions"):
                lines.append("  Regressions:")
                for reg in entry["regressions"]:
                    lines.append(f"    - {reg}")
        return "\n".join(lines)

    def usage_path(self):
        return self.target_dir / "token_usage.json"

    def _empty_usage_state(self) -> dict:
        return {
            "totals": empty_usage(),
            "components": {},
            "by_model": {},
            "updated_at": None,
        }

    def _load_usage_state(self) -> dict:
        path = self.usage_path()
        state = self._empty_usage_state()
        if not path.exists():
            return state
        try:
            raw = json.loads(path.read_text())
        except Exception:
            return state

        add_usage(state["totals"], raw.get("totals", {}), calls_if_missing=False)

        for name, usage in raw.get("components", {}).items():
            bucket = state["components"].setdefault(name, empty_usage())
            add_usage(bucket, usage, calls_if_missing=False)

        for model_key, usage in raw.get("by_model", {}).items():
            row = {
                "model_name": usage.get("model_name", model_key),
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "calls": 0,
            }
            add_usage(row, usage, calls_if_missing=False)
            state["by_model"][model_key] = row

        state["updated_at"] = raw.get("updated_at")
        return state

    def _save_usage_state(self):
        self.usage_path().write_text(json.dumps(self._usage_state, indent=2))

    def _track_usage(self, raw_usage: dict | None, component: str):
        if not isinstance(raw_usage, dict):
            return
        add_usage(self._usage_state["totals"], raw_usage)
        comp = self._usage_state["components"].setdefault(component, empty_usage())
        add_usage(comp, raw_usage)

        by_model = raw_usage.get("by_model", {})
        if isinstance(by_model, dict):
            for model_key, usage in by_model.items():
                bucket = self._usage_state["by_model"].setdefault(
                    model_key,
                    {
                        "model_name": usage.get("model_name", model_key),
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "total_tokens": 0,
                        "calls": 0,
                    },
                )
                add_usage(bucket, usage)

        self._usage_state["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_usage_state()

    def _consume_component_usage(self, component_name: str, component):
        if not hasattr(component, "consume_usage"):
            return
        usage = component.consume_usage()
        self._track_usage(usage, component_name)

    def _over_budget(self, config) -> bool:
        """Check if cumulative token usage exceeds the configured budget."""
        budget = getattr(config, "token_budget", 0)
        if budget <= 0:
            return False
        total = self._usage_state.get("totals", {}).get("total_tokens", 0)
        if total >= budget:
            self._log(f"TOKEN BUDGET EXCEEDED: {total:,} / {budget:,} tokens. Stopping.")
            return True
        return False

    @staticmethod
    def _enriched_summary(skill_content: str, config: AutoImproveConfig) -> str:
        """Build a skill summary enriched with constraints/safety context."""
        parts = [skill_content[:3500]]
        if config.constraints:
            parts.append("\nCONSTRAINTS: " + "; ".join(config.constraints))
        if config.safety_rules:
            parts.append("\nSAFETY RULES: " + "; ".join(config.safety_rules))
        return "".join(parts)[:4000]

    # -- Persistence --

    def config_path(self): return self.target_dir / "program.md"
    def bank_path(self):   return self.target_dir / "test_bank.json"
    def grade_cache_path(self): return self.target_dir / "grade_cache.json"

    def load_config(self):
        p = self.config_path()
        return AutoImproveConfig.load(str(p)) if p.exists() else AutoImproveConfig(target_skill=self.target_name)

    def save_config(self, cfg):
        cfg.save(str(self.config_path()))

    def load_bank(self):
        return load_test_bank(str(self.bank_path()))

    def save_bank(self, bank):
        save_test_bank(bank, str(self.bank_path()))

    def load_grade_cache(self) -> dict:
        path = self.grade_cache_path()
        if not path.exists():
            return {}
        try:
            payload = json.loads(path.read_text())
        except Exception:
            return {}
        if isinstance(payload, dict) and isinstance(payload.get("items"), dict):
            return payload["items"]
        if isinstance(payload, dict):
            # Backward compatibility if older cache was stored as plain dict.
            return payload
        return {}

    def save_grade_cache(self, cache: dict):
        self.grade_cache_path().write_text(
            json.dumps({"version": 1, "items": cache}, indent=2)
        )

    async def _grade_with_cache(self, grader: Grader, responses: list,
                                skill_summary: str, config: AutoImproveConfig,
                                cache: dict,
                                previous_scores: dict | None = None) -> tuple[list, dict]:
        """Grade responses using persistent cache; only miss entries call LLMs."""
        if not responses:
            return [], {"graded": 0, "cached": 0}

        previous_scores = previous_scores or {}
        verdict_by_test = {}
        to_grade = []

        for resp in responses:
            key = Grader.build_grade_key(resp, skill_summary, config)
            cached = cache.get(key)
            if cached:
                verdict = Verdict.from_dict(cached)
                verdict.test_id = resp.get("test_id", verdict.test_id)
                verdict_by_test[verdict.test_id] = verdict
                continue
            item = dict(resp)
            item["_grade_key"] = key
            to_grade.append(item)

        if to_grade:
            prev_subset = {
                r.get("test_id"): previous_scores.get(r.get("test_id"))
                for r in to_grade
                if r.get("test_id") in previous_scores
            }
            fresh = await grader.grade_batch(
                to_grade,
                skill_summary,
                config,
                previous_scores=prev_subset or None,
            )
            for resp, verdict in zip(to_grade, fresh):
                tid = resp.get("test_id", verdict.test_id)
                verdict.test_id = tid
                verdict_by_test[tid] = verdict
                cache_key = resp.get("_grade_key")
                if cache_key:
                    cache[cache_key] = verdict.to_dict()

        ordered = []
        for resp in responses:
            tid = resp.get("test_id", "unknown")
            verdict = verdict_by_test.get(tid)
            if verdict is None:
                verdict = Verdict(
                    test_id=tid,
                    grading_tier="error",
                    composite_score=0.0,
                    summary="Missing verdict",
                    flags=["error"],
                )
            ordered.append(verdict)

        return ordered, {
            "graded": len(to_grade),
            "cached": len(responses) - len(to_grade),
        }

    # -- Interview --

    async def run_interview_cli(self, skill_path: str):
        """Interactive CLI interview."""
        content = Path(skill_path).read_text()
        name = Path(skill_path).parent.name

        engine = InterviewEngine(name, content, skill_path)

        while not engine.is_complete():
            prompt = engine.get_next_prompt()
            if not prompt:
                break
            print(f"\n{prompt}\n")
            answer = input("> ").strip()

            result = engine.process_response(answer)
            if result == "confirm_program_revision":
                print("\nGot it, revising...\n")

        config = engine.build_config()
        self.save_config(config)
        self._log(f"\nSaved: {self.config_path()}")

        # Curated test cases from examples
        examples = engine.get_example_pairs()
        if examples:
            gen = QuestionGenerator.__new__(QuestionGenerator)
            bank = self.load_bank()
            for ex in examples:
                bank.append(gen.create_from_example(ex["question"], ex["answer"]))
            self.save_bank(bank)
            self._log(f"Added {len(examples)} curated test case(s)")

        return config

    # -- Question generation --

    async def generate_questions(self):
        config = self.load_config()
        content = Path(config.skill_path).read_text()

        self._log("Convening Three-Body Council for test questions...")
        gen = QuestionGenerator(verbose=self.verbose)
        new_tcs = await gen.channel_a(content, config)
        self._consume_component_usage("question_gen", gen)

        bank = self.load_bank()
        existing = {tc.id for tc in bank}
        added = [tc for tc in new_tcs if tc.id not in existing]
        bank.extend(added)
        self.save_bank(bank)
        self._log(f"Generated {len(added)} questions. Bank: {len(bank)} total")
        return bank

    # -- Baseline --

    async def run_baseline(self):
        config = self.load_config()
        bank = self.load_bank()
        content = Path(config.skill_path).read_text()

        self._log(f"Baseline: {len(bank)} questions...")
        responses = await self.runner.run_batch(content, bank, config.mode,
                                                style_notes=config.style_notes,
                                                skill_path=config.skill_path)
        self._consume_component_usage("runner", self.runner)

        self._log("Grading...")
        grader = Grader(verbose=self.verbose)
        grade_cache = self.load_grade_cache()
        verdicts, stats = await self._grade_with_cache(
            grader,
            responses,
            content[:3000],
            config,
            grade_cache,
        )
        if stats["graded"] > 0:
            self.save_grade_cache(grade_cache)
        self._log(
            f"  Graded {stats['graded']}/{len(responses)} "
            f"(cached {stats['cached']})"
        )
        self._consume_component_usage("grader", grader)

        scores = self.scorer.per_question_scores(verdicts)
        agg = self.scorer.weighted_mean(scores, bank)
        self.logger.log("baseline", 0.0, agg, True, "baseline")

        self._log(f"\nBaseline: {agg:.3f}")
        for tid, sc in sorted(scores.items(), key=lambda x: x[1]):
            self._log(f"  {tid}: {sc:.3f}")

        return {"scores": scores, "verdicts": verdicts, "aggregate": agg}

    # -- Improvement loop --

    async def run_loop(self, max_iters: int = None):
        config = self.load_config()
        bank = self.load_bank()
        skill_content = Path(config.skill_path).read_text()

        ratchet = Ratchet(config.repo_path, config.skill_path)
        grader = Grader(verbose=False)
        iters = max_iters or config.max_iterations

        if len(bank) < config.min_test_questions:
            self._log(f"WARNING: Only {len(bank)} questions (minimum {config.min_test_questions}). "
                       "Run 'generate' to add more.")

        self._log(f"Loop: {iters} iterations, {len(bank)} questions\n")
        grade_cache = self.load_grade_cache()

        # Baseline
        responses = await self.runner.run_batch(skill_content, bank, config.mode,
                                                style_notes=config.style_notes,
                                                skill_path=config.skill_path)
        self._consume_component_usage("runner", self.runner)
        baseline_summary = skill_content[:3000]
        verdicts, base_stats = await self._grade_with_cache(
            grader,
            responses,
            baseline_summary,
            config,
            grade_cache,
        )
        if base_stats["graded"] > 0:
            self.save_grade_cache(grade_cache)
        self._log(
            f"Baseline grading: graded {base_stats['graded']}/{len(responses)} "
            f"(cached {base_stats['cached']})"
        )
        self._consume_component_usage("grader", grader)
        cur_scores = self.scorer.per_question_scores(verdicts)
        cur_verdicts = verdicts
        cur_agg = self.scorer.weighted_mean(cur_scores, bank)
        prev_grade_keys = {
            r.get("test_id", ""): Grader.build_grade_key(r, baseline_summary, config)
            for r in responses
        }
        prev_response_hashes = {
            r.get("test_id", ""): r.get("response_hash", "")
            for r in responses
        }
        prev_verdict_map = {v.test_id: v for v in cur_verdicts}
        self._log(f"Baseline: {cur_agg:.3f}\n")

        consec_reverts = 0
        revert_details = []  # list of dicts with rich revert info
        tc_map = {tc.id: tc for tc in bank}

        for i in range(iters):
            if self._over_budget(config):
                break

            self._log(f"-- Iter {i+1}/{iters} --")

            if consec_reverts >= 3:
                self._log("3 consecutive reverts — stopping")
                break

            # Build all-scores summary for the improver (Fix 2)
            all_scores_lines = []
            for tid, sc in sorted(cur_scores.items(), key=lambda x: -x[1]):
                tc = tc_map.get(tid, TestCase(id="", question=""))
                marker = " ⚠ PROTECT" if sc >= 0.80 else ""
                all_scores_lines.append(
                    f"  {tid}: {sc:.2f} ({tc.difficulty}){marker}"
                )
            all_scores_str = "\n".join(all_scores_lines)

            # Build worst-questions payload (diversify after consecutive reverts)
            n_worst = 5
            skip_top = min(consec_reverts, 3)  # after reverts, look deeper
            all_worst = self.scorer.find_worst(cur_scores, n_worst + skip_top)
            worst = all_worst[skip_top:]  # skip the questions we keep failing on
            if not worst:
                worst = all_worst[:n_worst]

            verdict_map = {v.test_id: v for v in cur_verdicts}
            worst_payload = [{
                "test_id": tid,
                "question": tc_map.get(tid, TestCase(id="", question="")).question,
                "score": sc,
                "summary": verdict_map.get(tid, Verdict(test_id="")).summary,
                "flags": verdict_map.get(tid, Verdict(test_id="")).flags,
            } for tid, sc in worst]

            # Build rich edit history with revert reasons (Fix 1)
            edit_history = self._format_edit_history(revert_details)

            # Propose
            edit = await self.improver.propose(
                skill_content, config, worst_payload,
                edit_history=edit_history,
                all_scores=all_scores_str,
            )
            self._consume_component_usage("improver", self.improver)
            if not edit:
                self._log("  No edit proposed. Stopping.")
                break

            desc = edit.get("edit_description", "unknown")
            self._log(f"  Proposed: {desc}")

            if not self.improver.apply(config.skill_path, edit):
                self._log("  Apply failed. Skipping.")
                consec_reverts += 1
                continue

            modified = Path(config.skill_path).read_text()

            # Score
            new_resp = await self.runner.run_batch(modified, bank, config.mode,
                                                   style_notes=config.style_notes,
                                                   skill_path=config.skill_path)
            self._consume_component_usage("runner", self.runner)
            grading_summary = modified[:3000]
            new_grade_keys = {
                r.get("test_id", ""): Grader.build_grade_key(r, grading_summary, config)
                for r in new_resp
            }

            carry_forward = {}
            changed_resp = []
            hash_changed = 0
            for resp in new_resp:
                tid = resp.get("test_id", "")
                if resp.get("response_hash", "") != prev_response_hashes.get(tid, ""):
                    hash_changed += 1
                if new_grade_keys.get(tid) == prev_grade_keys.get(tid) and tid in prev_verdict_map:
                    carry_forward[tid] = prev_verdict_map[tid]
                else:
                    changed_resp.append(resp)

            changed_prev_scores = {
                r.get("test_id"): cur_scores.get(r.get("test_id"))
                for r in changed_resp
                if r.get("test_id") in cur_scores
            }
            regraded, grade_stats = await self._grade_with_cache(
                grader,
                changed_resp,
                grading_summary,
                config,
                grade_cache,
                previous_scores=changed_prev_scores,
            )
            if grade_stats["graded"] > 0:
                self.save_grade_cache(grade_cache)

            verdict_map = dict(carry_forward)
            verdict_map.update({v.test_id: v for v in regraded})

            new_verd = []
            for resp in new_resp:
                tid = resp.get("test_id", "")
                verdict = verdict_map.get(tid)
                if verdict is None:
                    verdict = Verdict(
                        test_id=tid,
                        grading_tier="error",
                        composite_score=0.0,
                        summary="Missing verdict",
                        flags=["error"],
                    )
                new_verd.append(verdict)

            self._log(
                f"  Re-graded {len(changed_resp)}/{len(new_resp)} "
                f"(cached {grade_stats['cached']}, carried {len(carry_forward)}, "
                f"hash-changed {hash_changed})"
            )
            self._consume_component_usage("grader", grader)
            new_scores = self.scorer.per_question_scores(new_verd)
            new_agg = self.scorer.weighted_mean(new_scores, bank)

            # Ratchet
            keep, reason = ratchet.should_keep(
                cur_scores, new_scores, cur_verdicts, new_verd,
                bank, config, self.scorer,
            )

            w_tid = min(new_scores, key=new_scores.get) if new_scores else ""
            w_sc = new_scores.get(w_tid, 0.0)
            prev_agg = cur_agg

            if keep:
                ratchet.commit(desc)
                self.logger.log(desc, prev_agg, new_agg, True, reason, w_tid, w_sc)
                cur_scores, cur_verdicts, cur_agg = new_scores, new_verd, new_agg
                skill_content = modified
                prev_grade_keys = new_grade_keys
                prev_response_hashes = {
                    r.get("test_id", ""): r.get("response_hash", "")
                    for r in new_resp
                }
                prev_verdict_map = {v.test_id: v for v in new_verd}
                consec_reverts = 0
                revert_details.clear()
                self._log(f"  KEPT ({prev_agg:.3f} -> {new_agg:.3f})")
            else:
                # Restore the known-good content to disk (works with or without git)
                Path(config.skill_path).write_text(skill_content)
                ratchet.revert()
                self.logger.log(desc, prev_agg, new_agg, False, reason, w_tid, w_sc)
                # Record rich revert info for the improver (Fix 1)
                regressions = []
                for tid in cur_scores:
                    before_s = cur_scores.get(tid, 0)
                    after_s = new_scores.get(tid, 0)
                    if before_s - after_s > 0.05:
                        tc = tc_map.get(tid, TestCase(id="", question=""))
                        regressions.append(
                            f"{tid} ({tc.intent_class}): {before_s:.2f} -> {after_s:.2f}"
                        )
                revert_details.append({
                    "edit": desc,
                    "reason": reason,
                    "agg_before": f"{prev_agg:.3f}",
                    "agg_after": f"{new_agg:.3f}",
                    "regressions": regressions,
                })
                consec_reverts += 1
                self._log(f"  REVERTED ({reason})")

            # Channel C every 5 iters (triggers on iterations 5, 10, 15, ...)
            if (i + 1) % 5 == 0:
                weak = [
                    {"id": t, "question": tc_map.get(t, TestCase(id="", question="")).question,
                     "score": s, "summary": "low"}
                    for t, s in cur_scores.items() if s < 0.5
                ]
                if weak:
                    self._log(f"  Expanding {len(weak)} weak areas...")
                    gen = QuestionGenerator(verbose=False)
                    summary = self._enriched_summary(skill_content, config)
                    new_tcs = await gen.channel_c(weak, summary)
                    self._consume_component_usage("question_gen", gen)
                    bank.extend(new_tcs)
                    tc_map.update({tc.id: tc for tc in new_tcs})
                    self.save_bank(bank)

        try: ratchet.push()
        except Exception: pass

        final = self.scorer.weighted_mean(cur_scores, bank)
        self._log(f"\nFinal: {final:.3f}")
        return {"aggregate": final, "scores": cur_scores, "verdicts": cur_verdicts}

    # -- Sweep (Karpathy loop) --

    async def sweep(self, max_rounds: int = 10, iters_per_round: int = 5):
        """
        The recursive self-improvement loop:
        1. Copy skill to a temp working file
        2. Run rounds of improvements until convergence
        3. Send original vs proposed diff to Telegram for approval
        4. If accepted: overwrite original, git commit + push, delete temp
        5. If rejected: delete temp, original untouched

        Requires interview + generate to have been run first.
        """
        config = self.load_config()
        if not config.skill_path or not Path(config.skill_path).exists():
            self._log("No config found. Run 'interview' and 'generate' first.")
            return

        bank = self.load_bank()
        if not bank:
            self._log("No test bank. Run 'generate' first.")
            return

        original_path = config.skill_path
        original_content = Path(original_path).read_text()

        # Work on a temp copy so the original is never touched until approval
        import tempfile
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".md", prefix=f"autoimprove_{self.target_name}_",
            dir="/tmp", delete=False,
        )
        tmp.write(original_content)
        tmp.close()
        working_path = tmp.name

        # Point config at the temp file for the duration of the sweep
        config.skill_path = working_path
        self.save_config(config)

        self._log(f"=== SWEEP: {self.target_name} ===")
        self._log(f"Skill: {original_path}")
        self._log(f"Working copy: {working_path}")
        self._log(f"Test bank: {len(bank)} questions")
        self._log(f"Max rounds: {max_rounds}, iters/round: {iters_per_round}")
        self._log("")

        prev_agg = 0.0
        stale_rounds = 0
        baseline_agg = 0.0

        for round_num in range(1, max_rounds + 1):
            if self._over_budget(config):
                break

            self._log(f"=== Round {round_num}/{max_rounds} ===")

            result = await self.run_loop(max_iters=iters_per_round)
            cur_agg = result["aggregate"] if result else 0.0

            if round_num == 1:
                baseline_agg = cur_agg

            improvement = cur_agg - prev_agg
            if round_num > 1:
                if improvement < config.min_improvement:
                    stale_rounds += 1
                    self._log(f"  Round delta: {improvement:+.4f} (stale {stale_rounds}/3)")
                else:
                    stale_rounds = 0
                    self._log(f"  Round delta: {improvement:+.4f}")

            if stale_rounds >= 3:
                self._log(f"\n3 stale rounds — converged at {cur_agg:.3f}")
                break

            prev_agg = cur_agg

            # Between rounds: expand test bank for weak areas
            if round_num < max_rounds:
                bank = self.load_bank()
                scores = result.get("scores", {})
                weak = [
                    {"id": tid, "question": tc.question, "score": scores.get(tid, 0.0),
                     "summary": "low score"}
                    for tc in bank
                    for tid in [tc.id]
                    if scores.get(tid, 1.0) < 0.5
                ]
                if weak:
                    self._log(f"\nGenerating follow-up questions for {len(weak)} weak areas...")
                    gen = QuestionGenerator(verbose=False)
                    working_content = Path(working_path).read_text()
                    summary = self._enriched_summary(working_content, config)
                    new_tcs = await gen.channel_c(weak[:3], summary)
                    self._consume_component_usage("question_gen", gen)
                    existing = {tc.id for tc in bank}
                    added = [tc for tc in new_tcs if tc.id not in existing]
                    bank.extend(added)
                    self.save_bank(bank)
                    if added:
                        self._log(f"Added {len(added)} new questions. Bank: {len(bank)} total")
                self._log("")

        # Restore config to point at the original
        config.skill_path = original_path
        self.save_config(config)

        modified_content = Path(working_path).read_text()

        self._log(f"\n=== SWEEP COMPLETE ===")
        self._log(f"Score: {baseline_agg:.3f} -> {prev_agg:.3f}")

        # If no changes were made, clean up and exit
        if original_content == modified_content:
            self._log("No changes to propose.")
            discard_proposed_skill(working_path)
            return

        # Send to Telegram for approval
        self._log("Sending to Telegram for approval...")
        tg = TelegramApproval()
        accepted = await tg.request_approval(
            skill_name=self.target_name,
            original=original_content,
            modified=modified_content,
            score_before=baseline_agg,
            score_after=prev_agg,
        )

        if accepted:
            self._log("ACCEPTED — applying to repo")
            apply_approved_skill(original_path, working_path, self.target_name)
            await tg.notify(f"AutoImprove: <b>{self.target_name}</b> updated and pushed.")
        else:
            self._log("REJECTED — discarding proposed changes")
            discard_proposed_skill(working_path)
            await tg.notify(f"AutoImprove: <b>{self.target_name}</b> changes discarded.")

        self._log(self.report())

    # -- Report --

    def _usage_report_lines(self) -> list[str]:
        totals = self._usage_state.get("totals", empty_usage())
        lines = [
            "Token usage (cumulative):",
            f"  input:  {totals.get('input_tokens', 0):,}",
            f"  output: {totals.get('output_tokens', 0):,}",
            f"  total:  {totals.get('total_tokens', 0):,}",
            f"  calls:  {totals.get('calls', 0):,}",
        ]

        components = self._usage_state.get("components", {})
        if components:
            lines.append("")
            lines.append("By component:")
            for name, usage in sorted(
                components.items(),
                key=lambda kv: kv[1].get("total_tokens", 0),
                reverse=True,
            ):
                lines.append(
                    f"  {name}: total={usage.get('total_tokens', 0):,} "
                    f"(in={usage.get('input_tokens', 0):,}, "
                    f"out={usage.get('output_tokens', 0):,}, "
                    f"calls={usage.get('calls', 0):,})"
                )
        return lines

    def report(self) -> str:
        entries = self.logger.parse_entries()
        if not entries:
            usage_lines = self._usage_report_lines()
            return "\n".join([f"No results for {self.target_name}.", ""] + usage_lines)

        non_bl = [e for e in entries if e.get("edit_description") != "baseline"]
        kept = sum(1 for e in non_bl if e.get("kept") == "True")
        reverted = len(non_bl) - kept

        baseline_entries = [e for e in entries if e.get("edit_description") == "baseline"]
        first_agg = (
            baseline_entries[-1].get("aggregate_after", "?")
            if baseline_entries else entries[0].get("aggregate_after", "?")
        )
        last_agg = entries[-1].get("aggregate_after", "?")

        lines = [
            f"AutoImprove Report — {self.target_name}",
            f"Date: {datetime.now().strftime('%Y-%m-%d')}",
            "",
            f"Starting score: {first_agg}",
            f"Current score:  {last_agg}",
            f"Edits proposed: {len(non_bl)}",
            f"Edits kept:     {kept}" + (f" ({kept*100//max(len(non_bl),1)}%)" if non_bl else ""),
            f"Edits reverted: {reverted}",
            "",
            "Recent changes:",
        ]
        for e in non_bl[-10:]:
            status = "KEPT" if e.get("kept") == "True" else f"REVERTED ({e.get('reason', '?')})"
            lines.append(f"  {e.get('edit_description', '?')} -> {status}")

        lines += [""] + self._usage_report_lines()

        return "\n".join(lines)


# ---------------------------------------------------------
# OpenClaw skill entry point
# ---------------------------------------------------------

SKILL_TRIGGERS = [
    "improve ", "make better", "autoimprove-tbc", "autoimprove", "self-improve", "tbc improve",
    "optimize skill", "tune up", "skill quality", "nightly improvement",
]

REPORT_TRIGGERS = [
    "autoimprove-tbc results", "autoimprove-tbc report", "autoimprove-tbc status", "autoimprove results", "autoimprove report", "autoimprove status",
    "what did autoimprove-tbc", "what did autoimprove", "improvement report",
]

SESSION_STATE_PATH = _AUTOIMPROVE_DIR / "runtime_sessions.json"
PAUSED_TARGETS_PATH = _AUTOIMPROVE_DIR / "paused_targets.json"


def _read_json_file(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def _write_json_file(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def _context_value(context, key: str):
    if isinstance(context, dict):
        return context.get(key)
    return getattr(context, key, None)


def _session_key(context) -> str:
    for key in ("session_id", "peer_id", "conversation_id"):
        val = _context_value(context, key)
        if val:
            return str(val)
    chat_id = _context_value(context, "chat_id")
    thread_id = _context_value(context, "thread_id") or _context_value(context, "topic_id")
    if chat_id:
        return f"chat:{chat_id}:thread:{thread_id or 'root'}"
    return "default"


def _load_sessions() -> dict:
    data = _read_json_file(SESSION_STATE_PATH, {})
    return data if isinstance(data, dict) else {}


def _save_sessions(data: dict):
    _write_json_file(SESSION_STATE_PATH, data)


def _load_paused_targets() -> set[str]:
    data = _read_json_file(PAUSED_TARGETS_PATH, [])
    if not isinstance(data, list):
        return set()
    return {str(x) for x in data}


def _save_paused_targets(paused: set[str]):
    _write_json_file(PAUSED_TARGETS_PATH, sorted(paused))


def _all_target_names() -> list[str]:
    if not TARGETS_DIR.exists():
        return []
    return sorted(d.name for d in TARGETS_DIR.iterdir() if d.is_dir())


def _resolve_target_name(hint: str) -> str | None:
    hint_l = hint.strip().lower()
    if not hint_l:
        return None
    targets = _all_target_names()
    for t in targets:
        if t.lower() == hint_l:
            return t
    for t in targets:
        if hint_l in t.lower():
            return t
    return None


def _resolve_skill_match(hint: str) -> tuple[str, Path, str] | None:
    raw_hint = hint.strip()
    if not raw_hint:
        return None

    direct_path = Path(raw_hint).expanduser()
    if direct_path.exists():
        candidate = direct_path
        if candidate.is_dir():
            candidate = candidate / "SKILL.md"
        if candidate.exists() and candidate.name.lower().endswith(".md"):
            name = candidate.parent.name
            content = candidate.read_text()
            return name, candidate, content

    hint_l = raw_hint.lower()
    if not _SKILLS_DIR.exists():
        return None

    candidates = []
    for d in _SKILLS_DIR.iterdir():
        if not d.is_dir():
            continue
        md = d / "SKILL.md"
        if md.exists():
            candidates.append((d.name, md))

    for name, md in candidates:
        if name.lower() == hint_l:
            content = md.read_text()
            return name, md, content

    for name, md in candidates:
        if hint_l in name.lower():
            content = md.read_text()
            return name, md, content

    return None


def _serialize_interview(engine: InterviewEngine) -> dict:
    return {
        "step_index": engine.step_index,
        "responses": dict(engine.responses),
        "example_pairs": list(engine.example_pairs),
    }


def _hydrate_interview(state: dict, skill_name: str, skill_content: str, skill_path: str) -> InterviewEngine:
    engine = InterviewEngine(skill_name, skill_content, skill_path)
    engine.step_index = int(state.get("step_index", 0))
    engine.responses = dict(state.get("responses", {}))
    engine.example_pairs = list(state.get("example_pairs", []))
    return engine


def _extract_improve_hint(user_input: str) -> str | None:
    text = user_input.strip()
    lower = text.lower()

    if lower.startswith("improve "):
        return text[len("improve "):].strip()
    if lower.startswith("optimize skill "):
        return text[len("optimize skill "):].strip()
    if lower.startswith("tune up "):
        return text[len("tune up "):].strip()
    if lower.startswith("make ") and lower.endswith(" better"):
        return text[len("make "):-len(" better")].strip()

    if lower in {"improve", "autoimprove-tbc", "autoimprove", "self-improve", "make better", "tbc improve"}:
        return ""

    return None


def _ensure_target_config(target_name: str, skill_path: str, skill_content: str):
    ai = AutoImprove(target_name, verbose=False)
    if not ai.config_path().exists():
        has_tools = ("web_search" in skill_content) or ("web_fetch" in skill_content)
        cfg = AutoImproveConfig(
            target_skill=target_name,
            skill_path=skill_path,
            mode="tool_simulation" if has_tools else "agent_simulation",
            audience="general users",
            expertise_level="mixed",
            style_notes="clear explanation with concrete examples",
        )
        ai.save_config(cfg)
    return ai


def _append_curated_test(target_name: str, skill_name: str, skill_path: str,
                         skill_content: str, question: str, answer: str = "") -> int:
    ai = _ensure_target_config(target_name, skill_path, skill_content)
    bank = ai.load_bank()
    tc_id = f"tq-curated-{int(datetime.now(timezone.utc).timestamp())}"
    bank.append(TestCase(
        id=tc_id,
        question=question,
        tier="curated",
        source="manual",
        created=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        verified_answer_summary=answer,
    ))
    ai.save_bank(bank)
    return len(bank)


def _format_test_bank(target_name: str) -> str:
    ai = AutoImprove(target_name, verbose=False)
    bank = ai.load_bank()
    if not bank:
        return f"Test bank for {target_name} is empty."
    lines = [f"Test bank — {target_name} ({len(bank)} questions):"]
    for tc in bank[:20]:
        lines.append(
            f"- {tc.id} [{tc.tier}/{tc.difficulty}] "
            f"score={tc.last_score:.3f} :: {tc.question[:120]}"
        )
    if len(bank) > 20:
        lines.append(f"... and {len(bank) - 20} more")
    return "\n".join(lines)


def _status_summary() -> str:
    targets = _all_target_names()
    if not targets:
        return "No autoimprove-tbc targets yet. Say 'improve [skill name]' to start."
    paused = _load_paused_targets()
    lines = ["AutoImprove status:"]
    for target in targets:
        ai = AutoImprove(target, verbose=False)
        entries = ai.logger.parse_entries()
        current = entries[-1].get("aggregate_after", "n/a") if entries else "n/a"
        state = "paused" if target in paused else "active"
        lines.append(f"- {target}: score={current} ({state})")
    return "\n".join(lines)


async def handle_skill_request(user_input: str, context=None):
    lower = user_input.lower().strip()

    session_id = _session_key(context)
    sessions = _load_sessions()
    active = sessions.get(session_id)

    if active:
        if lower in {"cancel", "stop", "abort", "nevermind", "never mind"}:
            sessions.pop(session_id, None)
            _save_sessions(sessions)
            return "AutoImprove interview cancelled."

        skill_path = str(active.get("skill_path", "")).strip()
        skill_name = str(active.get("skill_name", "")).strip()
        target_name = str(active.get("target_name", skill_name)).strip() or skill_name
        if not skill_path or not Path(skill_path).exists():
            sessions.pop(session_id, None)
            _save_sessions(sessions)
            return "Interview context expired (skill file missing). Say 'improve [skill]' to restart."

        content = Path(skill_path).read_text()
        engine = _hydrate_interview(active, skill_name, content, skill_path)
        result = engine.process_response(user_input.strip())

        if result == "confirm_program_revision":
            sessions[session_id] = {
                "skill_name": skill_name,
                "target_name": target_name,
                "skill_path": skill_path,
                **_serialize_interview(engine),
            }
            _save_sessions(sessions)
            return "\nGot it, revising.\n\n" + engine.get_next_prompt()

        if engine.is_complete():
            ai = AutoImprove(target_name, verbose=False)
            cfg = engine.build_config()
            ai.save_config(cfg)
            examples = engine.get_example_pairs()
            if examples:
                gen = QuestionGenerator.__new__(QuestionGenerator)
                bank = ai.load_bank()
                for ex in examples:
                    bank.append(gen.create_from_example(ex["question"], ex["answer"]))
                ai.save_bank(bank)
            sessions.pop(session_id, None)
            _save_sessions(sessions)
            return (
                f"Saved improvement program for **{target_name}**.\n"
                "Next: run `autoimprove.py generate --target "
                f"{target_name}` then `autoimprove.py baseline --target {target_name}`."
            )

        sessions[session_id] = {
            "skill_name": skill_name,
            "target_name": target_name,
            "skill_path": skill_path,
            **_serialize_interview(engine),
        }
        _save_sessions(sessions)
        return engine.get_next_prompt()

    if lower.startswith("autoimprove-tbc status") or lower.startswith("autoimprove status"):
        return _status_summary()

    pause_match = re.match(r"^(?:autoimprove-tbc|autoimprove)\s+(pause|resume)\s+(.+)$", lower)
    if pause_match:
        action = pause_match.group(1)
        target_hint = user_input.strip().split(None, 2)[-1].strip()
        target = _resolve_target_name(target_hint) or target_hint
        paused = _load_paused_targets()
        if action == "pause":
            paused.add(target)
            _save_paused_targets(paused)
            return f"Paused autoimprove-tbc target: {target}"
        paused.discard(target)
        _save_paused_targets(paused)
        return f"Resumed autoimprove-tbc target: {target}"

    add_match = re.match(r"^add test question for\s+(.+?)\s*::\s*(.+)$", user_input.strip(), re.IGNORECASE)
    if add_match:
        skill_hint = add_match.group(1).strip()
        payload = add_match.group(2).strip()
        question = payload
        answer = ""
        if "||" in payload:
            question, answer = [p.strip() for p in payload.split("||", 1)]

        resolved = _resolve_skill_match(skill_hint)
        if not resolved:
            return f"Couldn't find a skill matching '{skill_hint}'."
        skill_name, skill_md, skill_content = resolved
        if not question:
            return "Provide a question after `::`."

        total = _append_curated_test(
            target_name=skill_name,
            skill_name=skill_name,
            skill_path=str(skill_md),
            skill_content=skill_content,
            question=question,
            answer=answer,
        )
        return f"Added curated test question to {skill_name}. Bank now has {total} questions."

    if lower.startswith("add test question for "):
        return (
            "Use: `add test question for <skill> :: <question> || <ideal answer optional>`"
        )

    show_match = re.match(r"^show test bank for\s+(.+)$", user_input.strip(), re.IGNORECASE)
    if show_match:
        skill_hint = show_match.group(1).strip()
        target = _resolve_target_name(skill_hint)
        if target is None:
            resolved = _resolve_skill_match(skill_hint)
            if not resolved:
                return f"Couldn't find target/skill matching '{skill_hint}'."
            target = resolved[0]
        return _format_test_bank(target)

    if any(t in lower for t in REPORT_TRIGGERS):
        targets = _all_target_names()
        if not targets:
            return "No autoimprove-tbc targets yet. Say 'improve [skill name]' to start."
        return "\n\n---\n\n".join(AutoImprove(t, verbose=False).report() for t in targets)

    hint = _extract_improve_hint(user_input)
    if hint is None:
        return "Which skill should I improve? Name it, upload the SKILL.md, or give me the path."
    if not hint:
        return "Which skill should I improve?"

    resolved = _resolve_skill_match(hint)
    if not resolved:
        return f"Couldn't find a skill matching '{hint}'. Upload the SKILL.md or give me the path."

    skill_name, skill_md, content = resolved
    engine = InterviewEngine(skill_name, content, str(skill_md))
    sessions[session_id] = {
        "skill_name": skill_name,
        "target_name": skill_name,
        "skill_path": str(skill_md),
        **_serialize_interview(engine),
    }
    _save_sessions(sessions)
    return engine.get_next_prompt()


# ---------------------------------------------------------
# CLI
# ---------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="AutoImprove — Self-Improving Skill Loop")
    sub = parser.add_subparsers(dest="cmd")

    p = sub.add_parser("interview"); p.add_argument("--skill", required=True); p.add_argument("--target", default="")
    p = sub.add_parser("generate");  p.add_argument("--target", required=True)
    p = sub.add_parser("baseline");  p.add_argument("--target", required=True)
    p = sub.add_parser("run");       p.add_argument("--target", required=True); p.add_argument("--iterations", type=int, default=None)
    p = sub.add_parser("sweep");     p.add_argument("--target", required=True); p.add_argument("--rounds", type=int, default=10); p.add_argument("--iters", type=int, default=5)
    p = sub.add_parser("report");    p.add_argument("--target", required=True)

    args = parser.parse_args()

    if args.cmd == "interview":
        asyncio.run(AutoImprove(args.target or Path(args.skill).parent.name).run_interview_cli(args.skill))
    elif args.cmd == "generate":
        asyncio.run(AutoImprove(args.target).generate_questions())
    elif args.cmd == "baseline":
        asyncio.run(AutoImprove(args.target).run_baseline())
    elif args.cmd == "run":
        asyncio.run(AutoImprove(args.target).run_loop(args.iterations))
    elif args.cmd == "sweep":
        asyncio.run(AutoImprove(args.target).sweep(max_rounds=args.rounds, iters_per_round=args.iters))
    elif args.cmd == "report":
        print(AutoImprove(args.target, verbose=False).report())
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
