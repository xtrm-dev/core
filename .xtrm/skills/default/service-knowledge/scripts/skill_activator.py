#!/usr/bin/env python3
"""
PreToolUse hook: skill activator (research §3.7 firing point).

Fires before Read, Write, Edit, Glob, Grep, or Bash operations. When the operation touches a
registered service territory it invokes the per-repo FTS5 retrieval surface
(``knowledge_evidence_for_files`` / ``index.evidence_for_files``) and injects the resulting §3.2
evidence bundle into the PreToolUse context — replacing the old "please read SKILL.md" reminder
with real evidence.

Narrow blocking matrix (§3.7 — overblocking pushes agents around the system):

* Read / Glob / Grep           -> evidence-inject, NEVER block (even on a broken index)
* Write / Edit (registered)    -> block ONLY if retrieval cannot produce a bundle (unavailable
                                   machinery OR a broken index)
* Bash read-only               -> evidence-inject, never block
* Bash mutating (high-risk)    -> bundle + conflict-check; block only on a conflicted, high-risk
                                   prerequisite claim
* Bash specialist dispatch     -> attach the evidence bundle to the bead body before `sp`/
                                   `specialists --bead` runs (best-effort, never blocks)
* Bash `bd set-state contract=ready` -> contract-promotion gate; refuse when validation fails

Every block fails LOUDLY (service, territory, expected bundle, why retrieval failed) and has an
operator override: ``OVERRIDE_KNOWLEDGE_BUNDLE=1`` proceeds with a warning and is recorded in
telemetry as an override event. bd-tracking paths (``.beads/**``) never block so the promotion
gate cannot lock itself out. Telemetry: ``component=activator`` lines in
``.xtrm/state/service-knowledge/events.jsonl``.

Configured in the PreToolUse hook. Must stay fast and must never crash the tool call: any
unexpected error degrades to a silent no-op (exit 0).
"""

import fnmatch
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# bootstrap.py is a sibling in this consolidated scripts/ dir (no cross-skill hop).
sys.path.insert(0, str(Path(__file__).parent))

from bootstrap import (  # noqa: E402  # type: ignore[import-not-found]
    RootResolutionError,
    get_project_root,
    load_registry,
)

COMPONENT = "activator"
OVERRIDE_ENV = "OVERRIDE_KNOWLEDGE_BUNDLE"

READ_FILE_TOOLS = frozenset({"Read", "Glob", "Grep", "NotebookRead"})
WRITE_FILE_TOOLS = frozenset({"Write", "Edit", "NotebookEdit"})

# High-risk mutating Bash: destructive / state-changing commands that warrant a conflict gate.
MUTATING_BASH_PATTERNS = (
    re.compile(r"\brm\b"),
    re.compile(r"\bmv\b"),
    re.compile(r"\bdocker\s+(rm|rmi|compose\s+(down|rm)|system\s+prune)\b"),
    re.compile(r"\bsystemctl\s+(stop|restart|disable|reset-failed|daemon-reload)\b"),
    re.compile(r"\bkubectl\s+(apply|delete|rollout|scale|patch)\b"),
    re.compile(r"\bgh\s+pr\s+merge\b"),
    re.compile(r"\b(dropdb|drop\s+database|truncate|delete\s+from)\b", re.IGNORECASE),
    re.compile(r"\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)\b"),
)

# Paths the gate must never block on — otherwise the bead validator locks itself out.
EXEMPT_PATH_MARKERS = (".beads/", ".beads\\", "/.beads/", ".xtrm/state/", ".xtrm/cache/")

DISPATCH_COMPONENT = "dispatch"
PROMOTION_COMPONENT = "bead-validator"

# Conservative dispatch detection: a `sp`/`specialists` invocation carrying `--bead <id>`.
_DISPATCH_SEG_RE = re.compile(r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sp|specialists)\b(?P<args>.*)$")
_BEAD_ARG_RE = re.compile(r"--bead(?:=|\s+)(?P<id>[A-Za-z0-9_.:\-]+)")

# Conservative promotion detection: `bd ... set-state <id> ... contract=ready`.
_PROMOTION_RE = re.compile(
    r"\bbd\b[^\n]*?\bset-state\s+(?P<id>[A-Za-z0-9_.:\-]+)\s+[^\n]*?\bcontract=ready\b"
)


def match_territory(file_path: str, territory: list[str], project_root: Path) -> bool:
    """Check if a file path matches any territory glob pattern."""
    # Normalize to relative path
    fp = Path(file_path)
    if fp.is_absolute():
        try:
            fp = fp.relative_to(project_root)
        except ValueError:
            return False
    rel = str(fp)

    for pattern in territory:
        # fnmatch handles * and ?, but not ** — handle ** manually
        if "**" in pattern:
            # Split on **/ and check prefix + suffix
            parts = pattern.split("**/")
            if len(parts) == 2:
                prefix, suffix = parts
                rel_check = rel[len(prefix) :] if rel.startswith(prefix) else rel
                if fnmatch.fnmatch(rel_check, suffix) or fnmatch.fnmatch(
                    rel, f"{prefix}*/{suffix}"
                ):
                    return True
                # Also check if file is anywhere under the prefix dir
                if prefix and rel.startswith(prefix.rstrip("/")):
                    return True
        else:
            if fnmatch.fnmatch(rel, pattern):
                return True
        # Direct prefix match for broad patterns
        base = pattern.split("/*")[0].split("/**")[0]
        if base and (rel.startswith(base + "/") or rel == base):
            return True

    return False


def find_service_for_file(
    file_path: str, services: dict, project_root: Path
) -> tuple[str, dict] | None:
    """Return (service_id, service_data) if file is in any territory, else None."""
    for service_id, data in services.items():
        if match_territory(file_path, data.get("territory", []), project_root):
            return service_id, data
    return None


def find_service_for_command(command: str, services: dict) -> tuple[str, dict] | None:
    """Return (service_id, service_data) if command mentions a service name."""
    cmd_lower = command.lower()
    for service_id, data in services.items():
        # Match service_id directly or as a container name in docker commands
        if service_id in cmd_lower:
            return service_id, data
        # Match the container name pattern (service name with dashes/underscores)
        if data.get("name") and data.get("name", "").lower().replace(" ", "-") in cmd_lower:
            return service_id, data
    return None


def is_mutating_bash(command: str) -> bool:
    """True if a Bash command is high-risk / state-changing (warrants the conflict gate)."""
    return any(pattern.search(command) for pattern in MUTATING_BASH_PATTERNS)


def is_exempt_path(file_path: str) -> bool:
    """True for bd-tracking / derived-state paths the gate must never block on."""
    normalized = file_path.replace("\\", "/")
    return any(marker in normalized for marker in EXEMPT_PATH_MARKERS)


@dataclass(frozen=True)
class Retrieval:
    """Outcome of an evidence-retrieval attempt."""

    available: bool  # retrieval machinery importable at all
    ok: bool  # retrieval ran and produced a bundle
    bundle: dict[str, Any] | None = None
    error: str | None = None


@dataclass(frozen=True)
class Decision:
    """Block-matrix decision for one PreToolUse invocation."""

    action: str  # inject | block | allow | override
    reason: str
    context: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def retrieve_evidence(project_root: Path, paths: list[str]) -> Retrieval:
    """Invoke knowledge_evidence_for_files for ``paths``; never raises into the caller.

    ``available=False`` means the packaged index is not importable in this process (hook running
    standalone without the pip package) — that must NEVER block, only degrade to advisory.
    ``available=True, ok=False`` means a real retrieval failure (broken index) — that may block.
    """
    try:
        from service_knowledge import index  # type: ignore[import-not-found]
    except (ImportError, OSError, RuntimeError, ValueError, TypeError, KeyError):
        return Retrieval(available=False, ok=False, error="service-knowledge index not importable")
    try:
        bundle = index.evidence_for_files(Path(project_root), list(paths))
        try:
            from service_knowledge.dispatch import (
                bundle_identity,  # type: ignore[import-not-found]
            )

            bundle_id, evidence_hash = bundle_identity(bundle)
            bundle["bundle_id"] = bundle_id
            bundle["evidence_hash"] = evidence_hash
        except (ImportError, OSError, RuntimeError, ValueError, TypeError, KeyError):
            pass
        return Retrieval(available=True, ok=True, bundle=bundle)
    except (OSError, RuntimeError, ValueError, TypeError, KeyError) as exc:
        return Retrieval(available=True, ok=False, error=f"{type(exc).__name__}: {exc}")
    except Exception as exc:  # sqlite3.DatabaseError et al. — broken index
        return Retrieval(available=True, ok=False, error=f"{type(exc).__name__}: {exc}")


def bundle_has_blocking_conflict(bundle: dict[str, Any] | None) -> bool:
    """True if a conflicted, high-risk *prerequisite* claim gates a mutating command (§3.7 narrow).

    All three predicates must hold on one caveat: ``status == conflicted`` AND ``risk == high``
    AND a prerequisite/conflict edge (``conflicts_with``). Anything broader overblocks mutating
    Bash and pushes agents around the system.
    """
    if not bundle:
        return False
    for caveat in bundle.get("conflicts_and_caveats", []) or []:
        if str(caveat.get("status", "")) != "conflicted":
            continue
        if caveat.get("risk") != "high":
            continue
        if not caveat.get("conflicts_with"):  # prerequisite / conflict edge
            continue
        return True
    return False


def _format_bundle_context(bundle: dict[str, Any], service_id: str, territory: list[str]) -> str:
    """Render a §3.2 bundle into compact PreToolUse additionalContext (evidence, not a reminder)."""
    routing = bundle.get("routing", {}) or {}
    lines = [
        f"[Service Knowledge — evidence bundle for '{service_id}'] "
        f"territory: {', '.join(territory) or '(unspecified)'}",
        f"  source_ref: {routing.get('source_ref', '(unknown)')} | "
        f"matched: {', '.join(routing.get('matched_services', []) or []) or '(none)'}",
    ]
    items = bundle.get("items", []) or []
    if items:
        lines.append("  Top evidence:")
        for item in items[:5]:
            title = item.get("title", "(untitled)")
            status = item.get("status", "active")
            text = " ".join(str(item.get("text", "")).split())[:240]
            lines.append(f"   - [{item.get('kind', '?')}|{status}] {title}: {text}")
    else:
        lines.append("  (no indexed evidence items matched — index may be empty for this service)")
    caveats = bundle.get("conflicts_and_caveats", []) or []
    if caveats:
        lines.append("  Conflicts / caveats (resolve before mutating this territory):")
        for caveat in caveats[:5]:
            lines.append(
                f"   - [{caveat.get('status', '?')}|risk={caveat.get('risk', '?')}] "
                f"{caveat.get('title') or caveat.get('id', '?')}"
            )
    skill_links = bundle.get("skill_links", {}) or {}
    if skill_links:
        links = ", ".join(f"{sid}: {path}" for sid, path in skill_links.items())
        lines.append(f"  Full skills: {links}")
    return "\n".join(lines)


def build_block_message(
    service_id: str, territory: list[str], paths: list[str], error: str | None
) -> str:
    """A LOUD, actionable block message — silent blocks train agents to ignore hooks."""
    return (
        "[BLOCKED by service-knowledge] Write/Edit in a registered service territory was stopped "
        "because the evidence bundle could not be retrieved.\n"
        f"  Service:          {service_id}\n"
        f"  Territory:        {', '.join(territory) or '(unspecified)'}\n"
        f"  Paths touched:    {', '.join(paths) or '(unspecified)'}\n"
        f"  Expected bundle:  knowledge_evidence_for_files({paths})\n"
        f"  Retrieval failed: {error or 'unknown error'}\n"
        "  Fix: rebuild the index (`service-knowledge index rebuild`) and retry, or attach the "
        "evidence bundle to the bead body.\n"
        f"  Operator override: {OVERRIDE_ENV}=1 (proceeds with a warning; recorded in telemetry)."
    )


def decide(
    tool_name: str,
    *,
    service_id: str,
    territory: list[str],
    paths: list[str],
    retrieval: Retrieval,
    is_bash: bool,
    mutating: bool,
    override: bool,
    exempt: bool,
) -> Decision:
    """Pure §3.7 block-matrix decision. Read/Glob/Grep and read-only Bash never block."""
    bundle = retrieval.bundle
    context = _format_bundle_context(bundle, service_id, territory) if bundle else ""

    # Read-only file tools: evidence-inject, NEVER block (even on a broken index).
    if tool_name in READ_FILE_TOOLS:
        if retrieval.ok:
            return Decision("inject", "read-only tool: evidence injected, never blocks", context)
        return Decision("allow", "read-only tool: retrieval unavailable, advisory only (never blocks)")

    # Read-only Bash: evidence-inject, never block.
    if is_bash and not mutating:
        if retrieval.ok:
            return Decision("inject", "read-only bash: evidence injected, never blocks", context)
        return Decision("allow", "read-only bash: retrieval unavailable, advisory only (never blocks)")

    # From here: Write/Edit in registered territory, or mutating Bash. Blocking is possible.
    conflicting = bundle_has_blocking_conflict(bundle) if mutating else False

    block_reason: str | None = None
    if mutating and conflicting:
        block_reason = (
            f"mutating Bash conflicts with a high-risk prerequisite claim in '{service_id}' "
            f"(territory {', '.join(territory)}); resolve the conflict before proceeding"
        )
    elif not retrieval.ok and not exempt:
        # Registered Write/Edit demand evidence: block when no bundle is constructible, whether
        # retrieval is unavailable (machinery absent) or broken (index error).
        block_reason = build_block_message(service_id, territory, paths, retrieval.error)

    if block_reason is None:
        if retrieval.ok:
            return Decision("inject", "evidence injected for mutating/write operation", context)
        return Decision(
            "allow",
            "retrieval unavailable but not blocking (exempt bd-tracking path)",
            context,
        )

    if override:
        warned = f"[OVERRIDE] {OVERRIDE_ENV}=1 — proceeding despite: {block_reason}"
        return Decision(
            "override",
            block_reason,
            context=(f"{warned}\n\n{context}" if context else warned),
            extra={"override_reason": block_reason},
        )

    return Decision("block", block_reason, context)


def _emit_telemetry(project_root: Path, record: dict[str, Any]) -> None:
    """Append a component=activator line; never raises into the caller."""
    try:
        path = Path(project_root) / ".xtrm" / "state" / "service-knowledge" / "events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
    except OSError:
        pass


def _resolve_paths(tool_name: str, tool_input: dict, service_data: dict) -> list[str]:
    """Paths to retrieve evidence for: the file path, or the service territory for Bash."""
    if tool_name in READ_FILE_TOOLS or tool_name in WRITE_FILE_TOOLS:
        file_path = (
            tool_input.get("file_path")
            or tool_input.get("path")
            or tool_input.get("notebook_path")
            or ""
        )
        return [file_path] if file_path else []
    # Bash: seed retrieval with the matched service's territory (routing entry point).
    return list(service_data.get("territory", []) or [])


def parse_dispatch_bead(command: str) -> str | None:
    """Bead id from a `sp`/`specialists … --bead <id>` invocation, else None (conservative)."""
    for segment in re.split(r"[;&|\n]+", command or ""):
        match = _DISPATCH_SEG_RE.match(segment)
        if match:
            bead = _BEAD_ARG_RE.search(match.group("args"))
            if bead:
                return bead.group("id")
    return None


def parse_promotion_bead(command: str) -> str | None:
    """Bead id from a `bd … set-state <id> … contract=ready` promotion, else None (conservative)."""
    match = _PROMOTION_RE.search(command or "")
    return match.group("id") if match else None


def _run_bd(project_root: Path, args: list[str], *, stdin_text: str | None = None):
    """Run a `bd` subprocess against ``project_root``; never raises into the caller."""
    try:
        return subprocess.run(
            ["bd", *args],
            cwd=str(project_root),
            input=stdin_text,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def bd_show_json(project_root: Path, bead_id: str) -> dict[str, Any] | None:
    """First record from `bd show <id> --json`, or None when unreadable."""
    proc = _run_bd(project_root, ["show", bead_id, "--json"])
    if proc is None or proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        records = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None
    if isinstance(records, list):
        return records[0] if records else None
    return records if isinstance(records, dict) else None


def bd_update_description(project_root: Path, bead_id: str, body: str) -> bool:
    """Replace a bead's description via `bd update <id> --body-file -` (stdin). True on success."""
    proc = _run_bd(project_root, ["update", bead_id, "--body-file", "-"], stdin_text=body)
    return proc is not None and proc.returncode == 0


def _parse_bead_created_at(raw: Any) -> datetime | None:
    """Parse a bd-show ``created_at`` (nanosecond precision) to a naive datetime."""
    if not raw:
        return None
    text = re.sub(r"(\.\d{6})\d+", r"\1", str(raw).strip())
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def handle_dispatch(
    project_root: Path, bead_id: str, services: dict
) -> tuple[Decision, str, dict[str, Any]]:
    """Attach the §3.2 evidence bundle to a dispatched bead before sp/specialists runs.

    Best-effort and never blocking: a missing bead, empty SCOPE, or unavailable retrieval degrades
    to advisory. Returns ``(decision, component, telemetry_fields)``.
    """
    skip = {"event": "attach", "bead_id": bead_id, "bundle_id": None}
    try:
        from service_knowledge.dispatch import (  # type: ignore[import-not-found]
            attach_marker,
            extract_section,
            scope_matched_services,
            scope_path_tokens,
        )
    except (ImportError, OSError, RuntimeError, ValueError, TypeError, KeyError):
        return (Decision("allow", "dispatch: dispatch module unavailable, advisory only"),
                DISPATCH_COMPONENT, {**skip, "decision": "skipped"})

    record = bd_show_json(project_root, bead_id)
    if record is None:
        return (Decision("allow", f"dispatch: bead '{bead_id}' not readable via bd show, advisory only"),
                DISPATCH_COMPONENT, {**skip, "decision": "skipped"})

    body = str(record.get("description") or "")
    scope_text = extract_section(body, "SCOPE") or body
    paths = scope_path_tokens(scope_text)
    if not paths:
        for sid in scope_matched_services(scope_text, services):
            paths.extend((services.get(sid) or {}).get("territory", []) or [])
    if not paths:
        return (Decision("allow", "dispatch: no SCOPE paths to build evidence from, advisory only"),
                DISPATCH_COMPONENT, {**skip, "decision": "skipped"})

    retrieval = retrieve_evidence(project_root, paths)
    if not retrieval.ok or not retrieval.bundle:
        return (Decision("allow", f"dispatch: evidence unavailable ({retrieval.error}), advisory only"),
                DISPATCH_COMPONENT, {**skip, "decision": "skipped"})

    bundle = retrieval.bundle
    bundle_id = bundle.get("bundle_id")
    routing = bundle.get("routing", {}) or {}
    matched = list(routing.get("matched_services", []) or [])
    context = _format_bundle_context(bundle, ",".join(matched) or "unmatched", matched)
    fields = {"event": "attach", "bead_id": bead_id, "bundle_id": bundle_id,
              "service_ids": matched}

    updated = attach_marker(body, bundle)
    if updated == body:
        return (Decision("inject", f"dispatch: evidence bundle {bundle_id} already attached to '{bead_id}'", context),
                DISPATCH_COMPONENT, {**fields, "decision": "attached"})
    if not bd_update_description(project_root, bead_id, updated):
        return (Decision("allow", f"dispatch: bd update failed for '{bead_id}', advisory only"),
                DISPATCH_COMPONENT, {**fields, "decision": "failed"})
    return (Decision("inject", f"dispatch: attached evidence bundle {bundle_id} to bead '{bead_id}'", context),
            DISPATCH_COMPONENT, {**fields, "decision": "attached"})


def handle_promotion(
    project_root: Path, bead_id: str, services: dict, override: bool
) -> tuple[Decision, str, dict[str, Any]]:
    """Run the contract-promotion gate before `bd set-state <id> contract=ready`.

    Refuses (block) when validation fails, unless ``OVERRIDE_KNOWLEDGE_BUNDLE=1``. An unreadable
    bead stays advisory (never block on absent evidence). Returns ``(decision, component, fields)``.
    """
    try:
        from service_knowledge.dispatch import (  # type: ignore[import-not-found]
            ensure_gate_activated,
            validate_promotion,
        )
    except (ImportError, OSError, RuntimeError, ValueError, TypeError, KeyError):
        return (Decision("allow", "promotion: dispatch module unavailable, advisory only"),
                PROMOTION_COMPONENT, {"event": "promotion", "bead_id": bead_id, "decision": "allow"})

    record = bd_show_json(project_root, bead_id)
    if record is None:
        return (Decision("allow", f"promotion: bead '{bead_id}' not readable via bd show, advisory only"),
                PROMOTION_COMPONENT, {"event": "promotion", "bead_id": bead_id, "decision": "allow"})

    body = str(record.get("description") or "")
    created_at = _parse_bead_created_at(record.get("created_at"))
    effective = ensure_gate_activated(project_root)
    gate = validate_promotion(body, services, created_at=created_at, gate_effective=effective)

    if gate.allowed:
        action = "advisory" if gate.advisory else "allow"
        return (Decision(action, gate.reason, gate.reason if gate.advisory else ""),
                PROMOTION_COMPONENT,
                {"event": "promotion", "bead_id": bead_id, "decision": action,
                 "evidence_bundle_id": gate.evidence_bundle_id})
    if override:
        warned = f"[OVERRIDE] {OVERRIDE_ENV}=1 — proceeding despite: {gate.reason}"
        return (Decision("override", gate.reason, warned, extra={"override_reason": gate.reason}),
                PROMOTION_COMPONENT,
                {"event": "promotion", "bead_id": bead_id, "decision": "override",
                 "override_reason": gate.reason})
    reason = (
        f"[BLOCKED by service-knowledge] contract:draft -> contract:ready refused for bead '{bead_id}'.\n"
        f"  {gate.reason}"
    )
    return (Decision("block", reason, ""),
            PROMOTION_COMPONENT, {"event": "promotion", "bead_id": bead_id, "decision": "block"})


def _finish_gate(project_root: Path, decision: Decision, component: str,
                 fields: dict[str, Any], started: float) -> None:
    """Emit telemetry + PreToolUse output for a dispatch/promotion gate decision, then exit."""
    duration_ms = round((time.perf_counter() - started) * 1000.0, 2)
    record = {
        "timestamp": _utc_now_iso(),
        "component": component,
        "tool_name": "Bash",
        "decision": decision.action,
        "duration_ms": duration_ms,
        **fields,
    }
    _emit_telemetry(project_root, record)
    if decision.action == "block":
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": decision.reason,
            }
        }))
        sys.exit(0)
    if decision.context:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": decision.context,
            }
        }))
    sys.exit(0)


def main() -> None:
    started = time.perf_counter()
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}

    # This hook fires in EVERY repo (registry-gated at runtime), so stay cheap:
    # prefer $CLAUDE_PROJECT_DIR and avoid the git subprocess on the hot path.
    project_root_str = os.environ.get("CLAUDE_PROJECT_DIR")
    try:
        if not project_root_str:
            project_root_str = get_project_root()
        project_root = Path(project_root_str)
        services = load_registry(project_root_str).get("services", {})
    except (RootResolutionError, Exception):
        sys.exit(0)

    if not services:
        sys.exit(0)

    match = None
    file_path = ""
    command = ""

    if tool_name in READ_FILE_TOOLS or tool_name in WRITE_FILE_TOOLS:
        file_path = (
            tool_input.get("file_path")
            or tool_input.get("path")
            or tool_input.get("notebook_path")
            or ""
        )
        if file_path:
            match = find_service_for_file(file_path, services, project_root)
    elif tool_name == "Bash":
        command = tool_input.get("command", "")
        if command:
            override = os.environ.get(OVERRIDE_ENV, "") == "1"
            promotion_id = parse_promotion_bead(command)
            if promotion_id is not None:
                decision, component, fields = handle_promotion(
                    project_root, promotion_id, services, override)
                _finish_gate(project_root, decision, component, fields, started)
            dispatch_id = parse_dispatch_bead(command)
            if dispatch_id is not None:
                decision, component, fields = handle_dispatch(
                    project_root, dispatch_id, services)
                _finish_gate(project_root, decision, component, fields, started)
            match = find_service_for_command(command, services)

    if not match:
        sys.exit(0)

    service_id, service_data = match
    territory = list(service_data.get("territory", []) or [])
    mutating = bool(command) and is_mutating_bash(command)
    paths = _resolve_paths(tool_name, tool_input, service_data)
    retrieval = retrieve_evidence(project_root, paths)
    override = os.environ.get(OVERRIDE_ENV, "") == "1"
    exempt = bool(file_path) and is_exempt_path(file_path)

    decision = decide(
        tool_name,
        service_id=service_id,
        territory=territory,
        paths=paths,
        retrieval=retrieval,
        is_bash=tool_name == "Bash",
        mutating=mutating,
        override=override,
        exempt=exempt,
    )

    duration_ms = round((time.perf_counter() - started) * 1000.0, 2)
    bundle_id = (retrieval.bundle or {}).get("bundle_id")
    _emit_telemetry(
        project_root,
        {
            "timestamp": _utc_now_iso(),
            "component": COMPONENT,
            "event": "override" if decision.action == "override" else "pretooluse",
            "tool_name": tool_name,
            "service_ids": [service_id],
            "bundle_id": bundle_id,
            "decision": decision.action,
            "duration_ms": duration_ms,
            **({"override_reason": decision.extra.get("override_reason")} if decision.action == "override" else {}),
        },
    )

    if decision.action == "block":
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": decision.reason,
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    if decision.context:
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": decision.context,
            }
        }
        print(json.dumps(output))

    sys.exit(0)


if __name__ == "__main__":
    main()
