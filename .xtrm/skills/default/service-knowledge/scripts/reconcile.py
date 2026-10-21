#!/usr/bin/env python3
"""Standalone service-knowledge drift reconciler for zero-install runners."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
from bootstrap import get_project_root, load_registry, save_registry  # type: ignore[import-not-found]  # noqa: E402
from drift_detector import scan_drift  # type: ignore[import-not-found]  # noqa: E402

# PR1 verifier + PR2 gate lattice, imported in-process (no IPC / JSON round-trip). The
# gate is the ONLY path to atomic_write: reconcile.py, the service-knowledge-sync specialist
# and the auto-reconcile workflow all funnel through gated_write(), so the lattice cannot
# be bypassed (research §2.7). REVISION 3: deterministic only — no residual LLM critic.
from verifier import SourceCorpus, compute_gate, verify_candidate  # type: ignore[import-not-found]  # noqa: E402
from verifier.gate import GateDecision, source_fingerprint  # type: ignore[import-not-found]  # noqa: E402

# Canary policy (bead xtrm-56flm.7, package v0.7.0). Lazy-imported inside the
# helper so this file still works in the vendored consumer copy where the
# package isn't installed as `service_knowledge` — ImportError there is
# treated as canary OFF.


DEFAULT_NANO_GPT_URL = "https://nano-gpt.com/api/v1/chat/completions"
NANO_GPT_MODEL = os.environ.get("NANO_GPT_MODEL", "gpt-4o-mini")
ALLOWED_NANO_GPT_HOSTS = {"nano-gpt.com"}
SECRET_QUERY_PARAMS = {"api_key", "key", "token"}
TOKEN_CHARS = 4

GATE_COMPONENT = "reconcile-gate"
GATE_EVENT = "gate_decision"


@dataclass(frozen=True)
class ReconcileOptions:
    dry_run: bool
    max_files: int | None
    api_key: str
    cost_limit_tokens: int | None


@dataclass(frozen=True)
class LlmResult:
    content: str
    tokens: int


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reconcile service SKILL.md drift.")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON only")
    parser.add_argument("--dry-run", action="store_true", help="build prompts and call API without writes")
    parser.add_argument("--max-files", type=int, default=None, help="maximum drifted files to reconcile")
    return parser.parse_args(argv)


def parse_cost_limit(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    limit = int(value)
    if limit < 0:
        raise ValueError("XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS must be non-negative")
    return limit


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + TOKEN_CHARS - 1) // TOKEN_CHARS)


def build_prompt(drift: dict[str, Any], current_skill: str, source_evidence: str) -> str:
    """Trust model: source files come from the repo (trusted but commit-reviewed); LLM output is treated as PR-reviewed (human approves auto-PR)."""
    citations = {
        "symbols": drift.get("symbols", []),
        "processes": drift.get("processes", []),
        "cross_territory": drift.get("cross_territory", []),
        "tier": drift.get("tier"),
        "tier_source": drift.get("tier_source"),
        "gitnexus_status": drift.get("gitnexus_status"),
    }
    return "\n".join(
        [
            "You reconcile service skill documentation with implementation drift.",
            "Return only the complete updated SKILL.md content. No markdown fences. No commentary.",
            f"Service: {drift.get('service_id', 'unknown')} ({drift.get('service_name', 'unknown')})",
            f"Drifted source file: {drift.get('file_path', 'unknown')}",
            f"Drift evidence: {json.dumps(citations, sort_keys=True)}",
            "",
            "Current SKILL.md:",
            current_skill,
            "",
            "Source file evidence:",
            source_evidence,
        ]
    )


def parse_llm_response(payload: dict[str, Any]) -> LlmResult:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("nano-gpt response missing choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("nano-gpt response missing content")
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    total_tokens = usage.get("total_tokens", 0)
    return LlmResult(content=content.strip() + "\n", tokens=total_tokens if isinstance(total_tokens, int) else 0)


def get_nano_gpt_url() -> str:
    return os.environ.get("NANO_GPT_API_URL", DEFAULT_NANO_GPT_URL)


def validate_nano_gpt_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("NANO_GPT_API_URL must use https")
    if parsed.hostname not in ALLOWED_NANO_GPT_HOSTS:
        raise ValueError("NANO_GPT_API_URL host must be nano-gpt.com")
    query_keys = {key.lower() for key in parse_qs(parsed.query)}
    if query_keys & SECRET_QUERY_PARAMS:
        raise ValueError("NANO_GPT_API_URL must not contain secret query parameters")
    return url


def redact_exception(exc: Exception, api_key: str | None = None) -> str:
    message = f"{type(exc).__name__}: {str(exc)[:200]}"
    message = re.sub(r"Bearer\s+\S+", "Bearer [REDACTED]", message)
    if api_key:
        message = message.replace(api_key, "[REDACTED]")
    return message


def call_nano_gpt(prompt: str, api_key: str) -> LlmResult:
    try:
        import httpx  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("httpx is required for reconcile.py") from exc
    timeout = int(os.environ.get("NANO_GPT_TIMEOUT_SECONDS", "300"))
    response = httpx.post(
        validate_nano_gpt_url(get_nano_gpt_url()),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": NANO_GPT_MODEL, "messages": [{"role": "user", "content": prompt}]},
        timeout=timeout,
    )
    response.raise_for_status()
    return parse_llm_response(response.json())


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def gate_telemetry_path(state_root: Path) -> Path:
    """Append-only gate-decision log: ``<root>/.xtrm/state/service-knowledge/events.jsonl``."""
    return Path(state_root) / ".xtrm" / "state" / "service-knowledge" / "events.jsonl"


def emit_gate_telemetry(
    state_root: Path,
    decision: GateDecision,
    service_id: str,
    duration_ms: float,
    *,
    critic_calls: int = 0,
    critic_tokens: int = 0,
    stream=None,
) -> str:
    """Emit one structured ``component=reconcile-gate`` line per gate decision.

    REVISION 3 ships no residual LLM critic, so ``critic_calls`` / ``critic_tokens`` are
    always 0 — the fields stay in the schema for forward compatibility. Best-effort: a
    telemetry failure never breaks the reconcile.
    """
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "component": GATE_COMPONENT,
        "event": GATE_EVENT,
        "verdict": decision.verdict.value,
        "service_id": service_id,
        "invalid_count": decision.invalid_count,
        "conflict_count": decision.conflict_count,
        "unknown_count": decision.unknown_count,
        "critic_calls": critic_calls,
        "critic_tokens": critic_tokens,
        "duration_ms": round(duration_ms, 3),
    }
    line = json.dumps(record, sort_keys=True)
    try:
        path = gate_telemetry_path(state_root)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass
    if stream is not None:
        print(line, file=stream)
    return line


def run_verifier(
    candidate_path: Path,
    current_path: Path,
    territory: list[str],
    refs: str,
    *,
    service_id: str,
    source_root: Path,
) -> tuple[Any, bool]:
    """Run the PR1 verifier in-process with EVIDENCE_RACE detection.

    The candidate is verified against the service territory's source of truth. Source SHAs
    are fingerprinted at the start and end of the run; a mismatch means the source changed
    mid-run and the verdicts are unreliable (``evidence_race=True`` -> invalidate + retry).
    Returns ``(manifest, evidence_race)``.
    """
    candidate_text = Path(candidate_path).read_text(encoding="utf-8")
    current_text = Path(current_path).read_text(encoding="utf-8") if Path(current_path).exists() else ""
    globs = [g for g in (territory or []) if g]
    source_root = Path(source_root)
    fp_start = source_fingerprint(source_root, globs) if globs else ""
    corpus = SourceCorpus.from_globs(source_root, globs) if globs else SourceCorpus(base_dir=source_root)
    manifest = verify_candidate(
        candidate_text,
        current_text,
        service_id=service_id,
        corpus=corpus,
        verified_at_ref=refs,
        emit_telemetry=False,
    )
    fp_end = source_fingerprint(source_root, globs) if globs else ""
    evidence_race = bool(globs) and fp_start != fp_end
    return manifest, evidence_race


def gated_write(
    skill_path: Path,
    candidate_text: str,
    *,
    service_id: str,
    territory: list[str],
    source_root: Path,
    verified_at_ref: str = "",
    dry_run: bool = False,
    state_root: Path | None = None,
    emit_telemetry: bool = True,
) -> dict[str, Any]:
    """Gate a candidate SKILL before any canonical write (research §2.7 lattice).

    Writes the candidate to a temp path FIRST, runs the verifier, computes the gate, and
    ONLY on PASS / PASS_WITH_ADVISORIES calls :func:`atomic_write`. EVIDENCE_RACE invalidates
    + retries the whole verification once, then fails. Every decision emits one
    ``component=reconcile-gate`` telemetry line. Returns a result dict carrying the verdict,
    whether a write happened, the gate decision and the manifest.
    """
    started = time.perf_counter()
    skill_path = Path(skill_path)
    source_root = Path(source_root)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".candidate.md", delete=False) as handle:
        handle.write(candidate_text)
        candidate_path = Path(handle.name)
    try:
        manifest, evidence_race = run_verifier(
            candidate_path, skill_path, territory, verified_at_ref, service_id=service_id, source_root=source_root
        )
        decision = compute_gate(manifest, evidence_race=evidence_race)
        if decision.is_retryable:
            # Source changed mid-run: invalidate + retry the whole verification once.
            manifest, evidence_race = run_verifier(
                candidate_path, skill_path, territory, verified_at_ref, service_id=service_id, source_root=source_root
            )
            decision = compute_gate(manifest, evidence_race=evidence_race)
        duration_ms = (time.perf_counter() - started) * 1000.0
        if emit_telemetry:
            emit_gate_telemetry(state_root or source_root, decision, service_id, duration_ms)
        written = False
        if decision.is_writable and not dry_run:
            atomic_write(skill_path, candidate_path.read_text(encoding="utf-8"))
            written = True
        # Canary read-out (bead xtrm-56flm.7): decide whether the just-written diff
        # is eligible for auto-merge under the ratified per-class policy. Fail-closed
        # on any doubt (state file missing / malformed / claim class not enabled /
        # verdict not PASS / env override off). The write itself already happened —
        # this only controls the downstream auto-merge branch vs. normal PR.
        auto_merge, canary_reason, canary_state = _canary_evaluate(
            manifest,
            decision,
            state_root=state_root or source_root,
        )
        return {
            "verdict": decision.verdict.value,
            "written": written,
            "gate": decision.to_dict(),
            "manifest": manifest.to_dict(),
            "auto_merge": auto_merge,
            "canary": {"reason": canary_reason, "state": canary_state},
        }
    finally:
        try:
            candidate_path.unlink()
        except OSError:
            pass


def _canary_evaluate(manifest, decision, *, state_root):  # type: ignore[no-untyped-def]
    """Return ``(auto_merge, reason, state_snapshot)`` for a gated write.

    Delegates to :func:`service_knowledge.canary.decision.evaluate`. Import is
    lazy so this file still loads in the vendored consumer copy where the
    package is not installed as ``service_knowledge`` — an ImportError there is
    treated as canary OFF.
    """
    try:
        from service_knowledge.canary.decision import evaluate
    except ImportError:  # pragma: no cover - vendored path
        return False, "canary_module_unavailable", {"enabled": False, "classes": []}
    return evaluate(manifest, decision, state_root=Path(state_root))


def current_head(project_root: Path) -> str:
    result = subprocess.run(["git", "-C", str(project_root), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def find_skill_path(drift: dict[str, Any], registry: dict[str, Any], project_root: Path) -> str | None:
    skill_path = drift.get("skill_path")
    if not isinstance(skill_path, str) or not skill_path:
        service_id = drift.get("service_id")
        service = registry.get("services", {}).get(service_id) if isinstance(service_id, str) else None
        skill_path = service.get("skill_path") if isinstance(service, dict) else None
    if not isinstance(skill_path, str) or not skill_path:
        return None
    resolved_root = project_root.resolve()
    resolved_skill_path = (project_root / skill_path).resolve()
    if not resolved_skill_path.is_relative_to(resolved_root):
        raise ValueError(f"skill_path escapes project root: {skill_path}")
    return skill_path


def bump_last_sync_ref(project_root: Path, new_ref: str, dry_run: bool) -> str | None:
    # Mirrors drift_detector.update_sync_time: bump BOTH last_sync_ref (SHA) AND
    # last_sync (ISO timestamp). scan_drift compares file mtime against last_sync
    # — bumping only the ref left the timestamp at the old value, so post-merge
    # source file mtimes triggered drift on every subsequent merge (xtrm-qxu4y).
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    registry = load_registry(str(project_root))
    services = registry.get("services", {})
    old_refs = [service.get("last_sync_ref") for service in services.values() if isinstance(service, dict)]
    old_ref = next((ref for ref in old_refs if isinstance(ref, str) and ref), None)
    for service in services.values():
        if isinstance(service, dict):
            service["last_sync_ref"] = new_ref
            service["last_sync"] = now_iso
    if not dry_run:
        save_registry(registry, str(project_root))
        update_yaml_registry(project_root, new_ref, now_iso)
    return old_ref


def update_yaml_registry(project_root: Path, new_ref: str, new_sync_iso: str | None = None) -> None:
    for name in ("service-registry.yml", "service-registry.yaml"):
        path = project_root / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"(last_sync_ref:\s*)[^\n]*", rf"\g<1>{new_ref}", text)
        if new_sync_iso is not None:
            text = re.sub(r"(last_sync:\s*)[^\n]*", rf"\g<1>{new_sync_iso}", text)
        atomic_write(path, text)


def regenerate_umbrella_for_project(project_root: Path) -> dict[str, Any]:
    """Regenerate the per-repo umbrella from the just-stamped registry (B4).

    The umbrella table + index provenance + OKF envelopes are pure functions of the
    registry; only the ``<!-- SEMANTIC_START -->`` human block is preserved
    byte-identically across regen (marker contract shared with skill_migrator).
    Regeneration heals toward the registry: a hand-deleted envelope or a stale
    freshness cell is restored from the stamped registry on the next regen.
    Best-effort: never raises — reconcile surfaces a failure as partial rather
    than crashing a successful stamp.
    """
    try:
        from bootstrap import get_registry_path, get_umbrella_dir, load_registry as _load_registry  # type: ignore[import-not-found]  # noqa: E402
        from umbrella_generator import read_index_state, write_umbrella  # type: ignore[import-not-found]  # noqa: E402
    except ImportError as exc:
        return {"regenerated": False, "path": None, "reason": f"import_failed: {exc}"}
    try:
        umbrella_dir = None
        try:
            umbrella_dir = get_umbrella_dir(str(project_root))
        except Exception:
            umbrella_dir = None
        if umbrella_dir is None:
            try:
                reg_path = get_registry_path(str(project_root))
                if reg_path.parent.name in ("service-knowledge", "service-skills"):
                    umbrella_dir = reg_path.parent
            except Exception:
                umbrella_dir = None
        if umbrella_dir is None:
            return {"regenerated": False, "path": None, "reason": "no-umbrella-dir"}
        umbrella_path = Path(umbrella_dir) / "SKILL.md"
        registry = _load_registry(str(project_root))
        repo_name = Path(project_root).name
        try:
            index_state = read_index_state(str(project_root))
        except Exception:
            index_state = {}
        changed = write_umbrella(Path(umbrella_path), registry, repo_name, index_state or {})
        try:
            rel = Path(umbrella_path).relative_to(Path(project_root)).as_posix()
        except ValueError:
            rel = str(umbrella_path)
        return {"regenerated": changed, "path": rel, "reason": "generated" if changed else "unchanged"}
    except Exception as exc:
        return {"regenerated": False, "path": None, "reason": f"regen_failed: {type(exc).__name__}: {str(exc)[:160]}"}


def reconcile(options: ReconcileOptions) -> dict[str, Any]:
    project_root = Path(get_project_root())
    registry = load_registry(str(project_root))
    drifted = scan_drift(str(project_root), enrich_with_gitnexus=False, use_gitnexus=False)
    selected = drifted[: options.max_files] if options.max_files is not None else drifted
    truncated = len(selected) < len(drifted)
    result: dict[str, Any] = {
        # If --max-files truncated the drift list, the un-processed entries are
        # deferred — call the run partial so bump_last_sync_ref is skipped and
        # those services stay visible to the next scan_drift. Without this, all
        # services' last_sync gets stamped to now and the deferred drift is
        # silently masked (xtrm-vlxug).
        "status": "partial" if truncated else "success",
        "drift_count": len(drifted),
        "reconciled_count": 0,
        "failed": [],
        "cost_tokens": 0,
        "last_sync_ref_old": None,
        "last_sync_ref_new": current_head(project_root),
    }
    if truncated:
        for skipped in drifted[len(selected):]:
            result["failed"].append({
                "file_path": skipped.get("file_path"),
                "error": f"deferred: --max-files={options.max_files} truncated this entry",
            })
    for drift in selected:
        try:
            skill_path_value = find_skill_path(drift, registry, project_root)
            if not skill_path_value:
                raise ValueError(f"missing skill_path for {drift.get('service_id', 'unknown')}")
            skill_path = project_root / skill_path_value
            source_path = project_root / str(drift["file_path"])
            current_skill = skill_path.read_text(encoding="utf-8")
            prompt = build_prompt(drift, current_skill, source_path.read_text(encoding="utf-8", errors="ignore"))
            projected_tokens = result["cost_tokens"] + estimate_tokens(prompt)
            if options.cost_limit_tokens is not None and projected_tokens > options.cost_limit_tokens:
                result["status"] = "partial"
                result["failed"].append({"file_path": drift.get("file_path"), "error": "cost limit exceeded before request"})
                break
            llm_result = call_nano_gpt(prompt, options.api_key)
            result["cost_tokens"] += llm_result.tokens or estimate_tokens(prompt)
            if options.cost_limit_tokens is not None and result["cost_tokens"] > options.cost_limit_tokens:
                result["status"] = "partial"
                result["failed"].append({"file_path": drift.get("file_path"), "error": "cost limit exceeded after request"})
                break
            # PR2 gate: the candidate is verified BEFORE any canonical write. Only
            # PASS / PASS_WITH_ADVISORIES reach atomic_write; every other verdict is a
            # no-write (research §2.7). The gate is unavoidable — this is the single write
            # path shared by the specialist + the auto-reconcile workflow.
            service = registry.get("services", {}).get(drift.get("service_id"))
            territory = service.get("territory", []) if isinstance(service, dict) else []
            gate_result = gated_write(
                skill_path,
                llm_result.content,
                service_id=str(drift.get("service_id", "unknown")),
                territory=territory,
                source_root=project_root,
                verified_at_ref=result.get("last_sync_ref_new") or "",
                dry_run=options.dry_run,
                state_root=project_root,
            )
            result.setdefault("gates", []).append({
                "file_path": drift.get("file_path"),
                "service_id": drift.get("service_id"),
                "verdict": gate_result["verdict"],
                "written": gate_result["written"],
            })
            if options.dry_run:
                result["reconciled_count"] += 1
                continue
            if gate_result["written"]:
                result["reconciled_count"] += 1
            else:
                result["status"] = "partial"
                reasons = "; ".join(gate_result["gate"]["reasons"]) or "no reason recorded"
                result["failed"].append({
                    "file_path": drift.get("file_path"),
                    "error": f"gate={gate_result['verdict']}: {reasons}",
                })
        except Exception as exc:
            result["status"] = "partial"
            result["failed"].append({"file_path": drift.get("file_path"), "error": redact_exception(exc, options.api_key)})
    if result["reconciled_count"] and not (options.dry_run or result["status"] == "partial"):
        result["last_sync_ref_old"] = bump_last_sync_ref(project_root, result["last_sync_ref_new"], options.dry_run)
        # B4: a stamp without umbrella regen is a split-brain freshness display (registry
        # current while the umbrella table still shows the old sync). The umbrella is a
        # pure function of the registry + the preserved SEMANTIC block, so regen right
        # after the stamp keeps both convergent. Skipped only when nothing was stamped.
        regen = regenerate_umbrella_for_project(project_root)
        result["umbrella_regenerated"] = bool(regen.get("regenerated"))
        result["umbrella_path"] = regen.get("path")
        result["umbrella_reason"] = regen.get("reason")
        if regen.get("reason", "").startswith(("regen_failed", "import_failed", "no-umbrella")):
            result["status"] = "partial"
            result["failed"].append({
                "file_path": None,
                "error": f"umbrella_regen: {regen.get('reason')}",
            })
    else:
        result["umbrella_regenerated"] = False
        result["umbrella_path"] = None
        result["umbrella_reason"] = "dry-run" if options.dry_run else ("partial-no-stamp" if result["status"] == "partial" else "nothing-reconciled")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    api_key = os.environ.get("NANO_GPT_API_KEY")
    if not api_key:
        print("NANO_GPT_API_KEY is required for reconcile.py", file=sys.stderr)
        return 2
    try:
        validate_nano_gpt_url(get_nano_gpt_url())
        options = ReconcileOptions(args.dry_run, args.max_files, api_key, parse_cost_limit(os.environ.get("XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS")))
        output = reconcile(options)
    except Exception as exc:
        output = {"status": "failed", "drift_count": 0, "reconciled_count": 0, "failed": [{"file_path": None, "error": redact_exception(exc, api_key)}], "cost_tokens": 0, "last_sync_ref_old": None, "last_sync_ref_new": ""}
    print(json.dumps(output, sort_keys=True) if args.json else json.dumps(output, indent=2, sort_keys=True))
    # Exit 0 when the program achieved useful work (full or partial reconcile).
    # status field in the JSON carries the quality signal. Workflow gates on
    # status + reconciled_count to decide auto-PR; downstream shell scripts
    # that only check $? still get a clean signal for "anything reconciled".
    if output["status"] == "success":
        return 0
    if output["status"] == "partial" and int(output.get("reconciled_count", 0) or 0) > 0:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
