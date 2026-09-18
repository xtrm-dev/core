# Jev classification harness — XTRM Substrate cutover (§12–§13)

Harness: `scripts/jev_classify.py` (verified against `typesafe-sdk 0.7.0`).
Eval: `eval-jev-latest-2026-09-18.json` (model `jev-1.13.0`, 8 cases).

Headline: agreement 7/8 (0.875), escalation 0.25, false-rewrite 0.0,
~10.9k tokens total, 2.82s total latency.

Single MISS: `ambiguous-runtime-code` (claude-runtime-sync SEAM comment).
Expected UNKNOWN_REQUIRES_REVIEW, got ACTIVE_COMPATIBILITY (0.64, conf 0.59).
Analysis: the state evidence (generic resolver, hooks.json zero beads-* hooks,
successors planned-not-implemented) is genuinely compatibility-shaped — the
case label was arguably stricter than the evidence. Benign direction
(PRESERVE_UNTIL_CUTOVER, not a delete/write), and the deterministic
GitNexus/source step (§10) owns the final disposition either way.

Calibration notes:
- `migration-input`: 0.98 MIGRATION_INPUT but rec REVIEW via
  requires_human_review 0.56 — correctly conservative on destructive-adjacent
  assets (.beads must survive until verified import).
- `active-compatibility`: 0.50/0.50 split between ACTIVE_WRONG_AUTHORITY and
  ACTIVE_COMPATIBILITY — honest uncertainty on the live-enforcement boundary;
  rec REVIEW is the right outcome.
- No case recommended a destructive action; the recommendation vocabulary is
  allowlist-enforced in code (`ALLOWED_RECOMMENDATIONS` vs
  `FORBIDDEN_RECOMMENDATIONS`, fail-closed on collision).

Security: key read from `~/.secrets/typesafe_api_key.txt` at runtime only
(file holds `TYPESAFE_API_KEY=<key>`); never printed, committed, journaled,
or placed in Jev state.
