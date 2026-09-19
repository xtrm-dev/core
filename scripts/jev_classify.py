#!/usr/bin/env python3
"""Jev classification harness - XTRM Substrate cutover, third workstream (sections 12-13).

Flow:
    deterministic candidate discovery (caller-supplied)
      -> build_state()            small structured state per candidate
      -> classify()               Jev system_one(state, questions)
      -> candidate matrix row     Choice + Noul answers + usage
      -> GitNexus / source verification (operator / executor lane)
      -> deterministic final disposition (caller-owned; Jev never authorizes it)

Security contract (brief section 12):
  - API key read from ~/.secrets/typesafe_api_key.txt at runtime only.
  - The file holds TYPESAFE_API_KEY=<key>; parse the value after '='.
  - Key is never printed, never committed, never journaled, never in Jev state.
  - Jev output is advisory classification only. It must never authorize
    DELETE, MIGRATE, CLAIM, CLOSE, READY, or any destructive/authority action.
  - Allowed recommendations: PRESERVE, SEMANTIC_REWRITE, RESOLVE_CANONICAL_SOURCE,
    PRESERVE_UNTIL_CUTOVER, ZERO_CONSUMER_PROOF_REQUIRED, REVIEW.

Usage:
    python3 scripts/jev_classify.py --help
    python3 scripts/jev_classify.py classify --state state.json [--model jev-latest]
    python3 scripts/jev_classify.py eval [--model jev-latest] [--out eval-results.json]

Requires: pip install typesafe-sdk (verified against typesafe-sdk 0.7.0;
TypeSafeClient.system_one(state, questions) with Choice/Noul/Score,
SystemOneResponse answers/model/usage).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

SECRET_PATH = Path.home() / ".secrets" / "typesafe_api_key.txt"
DEFAULT_MODEL = "jev-latest"

# Brief section 11 - the full disposition vocabulary. Jev's Choice question uses
# these exact labels so its output maps 1:1 onto the deterministic disposition.
CLASSIFICATIONS = [
    "ACTIVE_WRONG_AUTHORITY",
    "ACTIVE_COMPATIBILITY",
    "INERT_PORTING_SOURCE",
    "MIGRATION_INPUT",
    "HISTORICAL_RECORD",
    "GENERATED_COPY",
    "DEAD_ZERO_CONSUMER",
    "UNKNOWN_REQUIRES_REVIEW",
]

CLASSIFICATION_DESCRIPTIONS = {
    "ACTIVE_WRONG_AUTHORITY": "Asset actively teaches or enforces Beads as the current work authority (guidance, gates, or runtime that must be semantically rewritten).",
    "ACTIVE_COMPATIBILITY": "Beads compatibility surface (alias, shim, probe, tombstone) still consumed by live code; preserve until cutover removes the consumer.",
    "INERT_PORTING_SOURCE": "Unwired legacy code preserved only as porting reference; no runtime effect.",
    "MIGRATION_INPUT": "Legacy source (e.g. .beads/ before verified import) awaiting the A9 import path; do not delete.",
    "HISTORICAL_RECORD": "Old ADR, report, or doc; history only, no runtime effect.",
    "GENERATED_COPY": "Generated mirror of a canonical source; fix the source, regenerate the copy.",
    "DEAD_ZERO_CONSUMER": "No consumers AND a verified successor exists; deletion still requires GitNexus/source proof, never Jev alone.",
    "UNKNOWN_REQUIRES_REVIEW": "Cannot decide from available evidence; escalate to human review.",
}

# Brief section 12 - atomic Noul questions. Each must be answerable from the
# state alone; none authorizes action, they only describe the asset.
NOUL_QUESTIONS = {
    "active_current_authority": "Is this asset part of the currently active guidance or runtime behavior (not history, not a generated copy)?",
    "teaches_beads_as_current_authority": "Does this asset teach or enforce Beads as the current work authority?",
    "semantic_rewrite_required": "Would making this asset Substrate-native require a semantic rewrite (not a mechanical rename)?",
    "active_runtime_dependency": "Does live runtime code depend on this asset's Beads behavior today?",
    "migration_evidence": "Is this asset evidence for, or input to, an in-flight or planned Beads-to-Substrate migration?",
    "historical_only": "Is this asset history only, with no effect on current runtime or guidance?",
    "generated_copy": "Is this asset a generated copy of a canonical source tracked elsewhere?",
    "likely_zero_consumer": "Does the evidence suggest this asset has no live consumers?",
    "requires_human_review": "Is this case ambiguous enough that a human must review before any disposition?",
    "contradicts_current_substrate_doctrine": "Does this asset contradict current Substrate doctrine (Issue/revision/readiness/claim/Journal/Resume Capsule/settlement+WorkReceipt/explicit Closure)?",
}

# Brief section 12 - the only recommendations Jev may emit. A collision with the
# forbidden set fails closed at build time (see build_questions).
ALLOWED_RECOMMENDATIONS = {
    "PRESERVE",
    "SEMANTIC_REWRITE",
    "RESOLVE_CANONICAL_SOURCE",
    "PRESERVE_UNTIL_CUTOVER",
    "ZERO_CONSUMER_PROOF_REQUIRED",
    "REVIEW",
}

FORBIDDEN_RECOMMENDATIONS = {
    "DELETE", "MIGRATE", "CLAIM", "CLOSE", "READY",
    "REMOVE", "PURGE", "APPROVE", "EXECUTE",
}


@dataclass
class CandidateState:
    """Small structured state per candidate (brief section 13). Never a repo dump."""

    repo: str
    path: str
    snippet: str
    context: str = ""
    file_category: str = ""
    history_summary: str = ""
    wiring_evidence: str = ""
    generated_relation: str = ""
    doctrine_summary: str = (
        "Substrate owns durable work: Issue/revision/readiness/claim, "
        "Journal continuity, Resume Capsule, settlement+WorkReceipt+provenance, "
        "explicit Closure. Beads is migration/history/compatibility only."
    )

    def to_dict(self) -> dict:
        return {
            "repo": self.repo,
            "path": self.path,
            "snippet": self.snippet,
            "context": self.context,
            "file_category": self.file_category,
            "history_summary": self.history_summary,
            "wiring_evidence": self.wiring_evidence,
            "generated_relation": self.generated_relation,
            "doctrine_summary": self.doctrine_summary,
        }


@dataclass
class ClassificationResult:
    candidate: dict
    classification: str
    probabilities: dict = field(default_factory=dict)
    confidence: float | None = None
    nouls: dict = field(default_factory=dict)
    recommendation: str = "REVIEW"
    model: str = ""
    usage: dict = field(default_factory=dict)
    latency_s: float = 0.0


def read_api_key(secret_path: Path = SECRET_PATH) -> str:
    """Read the key at runtime only. File holds TYPESAFE_API_KEY=<key>."""
    raw = secret_path.read_text().strip()
    if "=" in raw:
        _, _, value = raw.partition("=")
        key = value.strip().strip("'\"")
    else:
        key = raw
    if not key:
        raise ValueError("empty API key in %s" % secret_path)
    return key


def build_questions():
    """Build the Choice + Noul question set from the brief vocabulary."""
    from typesafe_sdk import Choice, Noul

    overlap = ALLOWED_RECOMMENDATIONS & FORBIDDEN_RECOMMENDATIONS
    if overlap:
        raise ValueError("recommendation vocabulary collision: %s" % (overlap,))
    questions = {
        "classification": Choice(
            instructions=(
                "Classify this Beads-related asset using exactly one label. "
                "Base the decision only on the provided state evidence."
            ),
            criteria={label: CLASSIFICATION_DESCRIPTIONS[label] for label in CLASSIFICATIONS},
        )
    }
    for name, text in NOUL_QUESTIONS.items():
        questions[name] = Noul(instructions=text)
    return questions


def derive_recommendation(classification: str, nouls: dict) -> str:
    """Deterministic local mapping from Jev answers to an allowed recommendation.

    Runs locally, not in Jev: Jev describes, this function recommends - and only
    from the allowlist. Final disposition additionally requires GitNexus/source
    verification by the caller (brief section 10).
    """
    review = nouls.get("requires_human_review", 0) or 0
    if classification == "UNKNOWN_REQUIRES_REVIEW" or review >= 0.5:
        return "REVIEW"
    mapping = {
        "ACTIVE_WRONG_AUTHORITY": "SEMANTIC_REWRITE",
        "ACTIVE_COMPATIBILITY": "PRESERVE_UNTIL_CUTOVER",
        "INERT_PORTING_SOURCE": "PRESERVE",
        "MIGRATION_INPUT": "PRESERVE",
        "HISTORICAL_RECORD": "PRESERVE",
        "GENERATED_COPY": "RESOLVE_CANONICAL_SOURCE",
        "DEAD_ZERO_CONSUMER": "ZERO_CONSUMER_PROOF_REQUIRED",
    }
    return mapping.get(classification, "REVIEW")


def classify(candidate: CandidateState, model: str = DEFAULT_MODEL,
             client=None) -> ClassificationResult:
    """Run one candidate through Jev and return the matrix row."""
    from typesafe_sdk import TypeSafeClient

    owned = client is None
    client = client or TypeSafeClient(api_key=read_api_key())
    try:
        questions = build_questions()
        started = time.monotonic()
        response = client.system_one(candidate.to_dict(), questions, model=model)
        latency = time.monotonic() - started
        choice = response.choices["classification"]
        classification = choice.choice
        nouls = {name: float(ans.noul) for name, ans in response.nouls.items()}
        usage = response.usage
        usage_dict = {
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
        }
        return ClassificationResult(
            candidate=candidate.to_dict(),
            classification=classification,
            probabilities=dict(choice.probabilities or {}),
            confidence=choice.confidence,
            nouls=nouls,
            recommendation=derive_recommendation(classification, nouls),
            model=response.model,
            usage=usage_dict,
            latency_s=round(latency, 2),
        )
    finally:
        if owned:
            client.close()


def result_to_dict(r: ClassificationResult) -> dict:
    return {
        "path": r.candidate.get("path"),
        "classification": r.classification,
        "probabilities": r.probabilities,
        "confidence": r.confidence,
        "nouls": r.nouls,
        "recommendation": r.recommendation,
        "model": r.model,
        "usage": r.usage,
        "latency_s": r.latency_s,
    }


# Brief section 13 - required evaluation set. Each case pins the expected label
# so the eval measures agreement instead of vibes. Cases rest on the completed
# runtime-reconciliation lanes (CORE-2299/2300/2301 evidence): labels come from
# GitNexus/source proof, not from Jev output.
EVAL_CASES: list[dict] = [
    {
        "id": "obvious-active-wrong-authority",
        "expected": "ACTIVE_WRONG_AUTHORITY",
        "candidate": {
            "repo": "core", "path": "docs/legacy-beads-workflow.md",
            "snippet": "Run bd prime, then bd ready, claim the bead with bd update --claim, append progress notes, bd close when done.",
            "context": "Onboarding doc linked from the repo README; instructs every new agent to work Beads-first.",
            "file_category": "active-guidance",
            "history_summary": "Unchanged since the Beads era; never revised for Substrate.",
            "wiring_evidence": "Linked from README quickstart; no code dependency.",
            "generated_relation": "canonical source (not generated)",
        },
    },
    {
        "id": "obvious-historical-record",
        "expected": "HISTORICAL_RECORD",
        "candidate": {
            "repo": "core", "path": "docs/adr/adr-0042-beads-backend.md",
            "snippet": "Decision: adopt Beads Supervisor/RPC as the durable work backend (2025).",
            "context": "Superseded ADR retained for history; Substrate is the current backend.",
            "file_category": "adr",
            "history_summary": "Closed decision record; explicitly marked superseded.",
            "wiring_evidence": "No code or guidance references it as current authority.",
            "generated_relation": "canonical source (not generated)",
        },
    },
    {
        "id": "migration-input",
        "expected": "MIGRATION_INPUT",
        "candidate": {
            "repo": "core", "path": ".beads/issues.jsonl",
            "snippet": "legacy board rows: id core-abc.1, title, status open",
            "context": "Legacy board awaiting A9 import; sb import beads --dry-run not yet run.",
            "file_category": "legacy-board",
            "history_summary": "Live legacy tracker; export hash recorded in migration preflight.",
            "wiring_evidence": "Read by bd CLI; must survive until verified import receipt.",
            "generated_relation": "source data for migration",
        },
    },
    {
        "id": "generated-mirror",
        "expected": "GENERATED_COPY",
        "candidate": {
            "repo": "core", "path": ".xtrm/skills/default/using-specialists/SKILL.md",
            "snippet": "vendored from xtrm-dev/specialists; do not hand-edit (header marker).",
            "context": "Vendored mirror regenerated by scripts/vendor-specialists-skills.mjs from the specialists repo pin.",
            "file_category": "vendored-skill",
            "history_summary": "Regenerated at each vendor run; canonical source is specialists repo.",
            "wiring_evidence": "Read by skill loader; writes go to the specialists repo.",
            "generated_relation": "generated from xtrm-dev/specialists using-specialists SKILL.md",
        },
    },
    {
        "id": "active-compatibility",
        "expected": "ACTIVE_COMPATIBILITY",
        "candidate": {
            "repo": "core", "path": "packages/pi-extensions/extensions/beads/index.ts",
            "snippet": "isBeadsProject probes .beads dir; edit gate on claim cache via bd kv.",
            "context": "CORE-2300 evidence: live edit/commit gating; no Substrate Pi successor registered; policies/beads.json tombstone keeps check-pi green.",
            "file_category": "runtime-extension",
            "history_summary": "Active enforcement; retirement is A9-dependent.",
            "wiring_evidence": "Manifest beads required:true; callers beads + session-flow only; removing breaks gating.",
            "generated_relation": "canonical source (not generated)",
        },
    },
    {
        "id": "ambiguous-runtime-code",
        "expected": "UNKNOWN_REQUIRES_REVIEW",
        "candidate": {
            "repo": "core", "path": "cli/src/core/claude-runtime-sync.ts",
            "snippet": "SEAM comment maps retired beads hooks to substrate successors; resolver stays generic.",
            "context": "CORE-2300 evidence: comment-only Beads sensitivity; hooks.json verified zero beads hooks; successors planned, not implemented.",
            "file_category": "runtime-command",
            "history_summary": "Already retired; generic resolver with fail-open dedupe guard.",
            "wiring_evidence": "reconcileGlobalClaudeHooks impact MEDIUM (5 direct callers + tests).",
            "generated_relation": "canonical source (not generated)",
        },
    },
    {
        "id": "known-dead-asset",
        "expected": "DEAD_ZERO_CONSUMER",
        "candidate": {
            "repo": "core", "path": "cli/src/core/beads-status-cache.ts",
            "snippet": "Standalone Beads status cache; superseded by Substrate projection reads.",
            "context": "No imports found via GitNexus context; successor is Substrate projection (per section 9 disposition table).",
            "file_category": "runtime-core",
            "history_summary": "Untouched since the Substrate projection landed.",
            "wiring_evidence": "GitNexus: zero callers; successor verified in substrate.ts read path.",
            "generated_relation": "canonical source (not generated)",
        },
    },
    {
        "id": "adversarial-filename-only",
        "expected": "HISTORICAL_RECORD",
        "candidate": {
            "repo": "core", "path": "docs/retros/2025-beads-outage-retro.md",
            "snippet": "Retro: Beads shared-server outage, action items completed, board healthy since.",
            "context": "Filename mentions beads but content is a closed incident retro; no current authority claim.",
            "file_category": "retro",
            "history_summary": "Closed incident record.",
            "wiring_evidence": "No code or guidance references; linked only from retro index.",
            "generated_relation": "canonical source (not generated)",
        },
    },
]


def run_eval(model: str = DEFAULT_MODEL, out: Path | None = None) -> dict:
    """Run the 8-case labeled eval; measure agreement, escalation, latency, cost."""
    from typesafe_sdk import TypeSafeClient

    client = TypeSafeClient(api_key=read_api_key())
    try:
        rows = []
        for case in EVAL_CASES:
            cand = CandidateState(**case["candidate"])
            try:
                r = classify(cand, model=model, client=client)
                row = {"id": case["id"], "expected": case["expected"], **result_to_dict(r),
                       "agree": r.classification == case["expected"], "error": None}
            except Exception as e:
                row = {"id": case["id"], "expected": case["expected"],
                       "classification": None, "probabilities": {}, "confidence": None,
                       "nouls": {}, "recommendation": "REVIEW", "model": model,
                       "usage": {}, "latency_s": 0.0,
                       "agree": False, "error": "%s: %s" % (type(e).__name__, e)}
            rows.append(row)
        ok = [r for r in rows if not r["error"]]
        summary = {
            "model": model,
            "cases": len(rows),
            "errors": len(rows) - len(ok),
            "agreement": round(sum(1 for r in ok if r["agree"]) / len(ok), 3) if ok else 0.0,
            "escalation_rate": round(sum(1 for r in ok if r["recommendation"] == "REVIEW") / len(ok), 3) if ok else 0.0,
            "false_rewrite_rate": round(sum(
                1 for r in ok
                if r["classification"] == "ACTIVE_WRONG_AUTHORITY" and r["expected"] != "ACTIVE_WRONG_AUTHORITY"
            ) / len(ok), 3) if ok else 0.0,
            "total_input_tokens": sum(r["usage"].get("input_tokens", 0) for r in ok),
            "total_output_tokens": sum(r["usage"].get("output_tokens", 0) for r in ok),
            "total_latency_s": round(sum(r["latency_s"] for r in ok), 2),
            "rows": rows,
        }
        if out:
            out.write_text(json.dumps(summary, indent=2))
        return summary
    finally:
        client.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Jev classification harness (XTRM section 12-13)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_class = sub.add_parser("classify", help="classify one candidate state JSON file")
    p_class.add_argument("--state", required=True, help="JSON file with CandidateState fields")
    p_class.add_argument("--model", default=DEFAULT_MODEL)
    p_eval = sub.add_parser("eval", help="run the 8-case labeled eval set")
    p_eval.add_argument("--model", default=DEFAULT_MODEL)
    p_eval.add_argument("--out", default=None, help="write JSON results file")
    args = ap.parse_args(argv)
    if args.cmd == "classify":
        data = json.loads(Path(args.state).read_text())
        r = classify(CandidateState(**data), model=args.model)
        print(json.dumps(result_to_dict(r), indent=2))
        return 0
    if args.cmd == "eval":
        summary = run_eval(model=args.model, out=Path(args.out) if args.out else None)
        print(json.dumps({k: v for k, v in summary.items() if k != "rows"}, indent=2))
        for r in summary["rows"]:
            mark = "OK " if r["agree"] and not r["error"] else "MISS" if not r["error"] else "ERR "
            print("%s %s: expected=%s got=%s rec=%s%s" % (
                mark, r["id"], r["expected"], r["classification"], r["recommendation"],
                (" err=" + r["error"]) if r["error"] else ""))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
