#!/usr/bin/env python3
"""CI committed-drift gate for service-knowledge (B5, XTRM-648).

Authoritative gate for *committed* drift. Read-only: never writes the pending
marker, never builds/repairs the per-checkout FTS5 cache (gitignored derived
artifact — Layer 1 owns local freshness via the read-time source_ref-vs-HEAD
gate). Blocks merge (exit 1) on:

  - dirty drift: ``scan_drift(..., use_gitnexus=False)`` non-empty, or
  - umbrella/registry mismatch: the checked-in umbrella Services table does
    not match ``service-registry.json`` (registry changed without regen), or a
    registered ``skill_path`` is missing.

Seconds-budgeted, touches-gated, no gitnexus enrichment:

  - Reuses the B2 touches gate by calling ``drift_detector.scan_drift`` with
    ``use_gitnexus=False`` — the same tracked-only, territory-glob, ref-first
    (``last_sync_ref..HEAD``) scoping the post-merge/post-checkout/post-rewrite
    hooks gate on. No mtime false-positive storm on fresh checkouts beyond what
    ``scan_drift`` itself reports with ``reason=range-unknown``; no subprocess
    fan-out (``DRIFT_MAX_ENRICH`` cap is irrelevant with gitnexus disabled).
  - Umbrella comparison is pure string rendering (``generate_umbrella`` with an
    empty index state, Services-table section only) — no sqlite open, no index
    build. The Knowledge-Index provenance block is Layer-1 owned and explicitly
    excluded from the comparison.

Exit codes: 0 clean, 1 dirty/mismatch (merge must block), 2 infra error
(unresolvable root, unimportable engine). Always prints a one-paragraph human
summary plus ``::error::`` annotations for the workflow to surface.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

try:
    from drift_detector import scan_drift  # type: ignore[import-not-found]
except ImportError as exc:
    print(f"::error::ci-drift-check: cannot import drift_detector: {exc}", file=sys.stderr)
    raise SystemExit(2)

try:
    from umbrella_generator import generate_umbrella  # type: ignore[import-not-found]
except ImportError as exc:
    print(f"::error::ci-drift-check: cannot import umbrella_generator: {exc}", file=sys.stderr)
    raise SystemExit(2)

RESERVED_PACKS = {"default", "optional", "user", "active", "local-legacy"}
UMBRELLA_NAMES = ("service-knowledge", "service-skills")
DEFAULT_BUDGET_SECONDS = 60.0


def _project_root(explicit: str | None) -> Path:
    if explicit:
        root = Path(explicit).expanduser().resolve()
        if not root.is_dir():
            print(f"::error::ci-drift-check: --path is not a directory: {root}", file=sys.stderr)
            raise SystemExit(2)
        return root
    try:
        import subprocess

        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True, timeout=5,
        )
        return Path(r.stdout.strip()).resolve()
    except Exception as exc:
        print(f"::error::ci-drift-check: cannot resolve repo root: {exc}", file=sys.stderr)
        raise SystemExit(2)


def _find_umbrella_packs(root: Path) -> list[tuple[Path, Path]]:
    """Mirror of cli.common.find_umbrella_packs (new umbrella name wins)."""
    out: list[tuple[Path, Path]] = []
    seen: set[Path] = set()
    skills_root = root / ".xtrm" / "skills"
    candidates = [skills_root, skills_root / "user" / "packs"]
    for packs_root in candidates:
        if not packs_root.is_dir():
            continue
        for pack in sorted(p for p in packs_root.iterdir() if p.is_dir() and p.name not in RESERVED_PACKS):
            resolved = pack.resolve()
            if resolved in seen:
                continue
            for name in UMBRELLA_NAMES:
                umb = pack / name
                if (umb / "service-registry.json").is_file():
                    seen.add(resolved)
                    out.append((pack, umb))
                    break
    return out


def _services_table_section(text: str) -> str:
    """Services-table section only (registry-derived). Excludes the Layer-1-owned
    Knowledge-Index provenance block (source_ref/items/built_at vary per checkout)."""
    start = text.find("## Services")
    if start == -1:
        return ""
    end = text.find("## Cross-Service Health", start)
    section = text[start:end] if end != -1 else text[start:]
    return section.strip()


def _check_umbrellas(root: Path) -> list[str]:
    """Return mismatch descriptions (empty when convergent). Read-only."""
    problems: list[str] = []
    for pack, umb in _find_umbrella_packs(root):
        reg_path = umb / "service-registry.json"
        umbrella_path = umb / "SKILL.md"
        try:
            registry = json.loads(reg_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            problems.append(f"pack '{pack.name}': unreadable registry ({exc})")
            continue
        services = registry.get("services", {})
        if not isinstance(services, dict):
            problems.append(f"pack '{pack.name}': registry 'services' is not an object")
            continue
        # Every registered skill_path must exist (stale rename/move = mismatch).
        for sid, info in services.items():
            skill_rel = info.get("skill_path", "") if isinstance(info, dict) else ""
            if not skill_rel or not (root / skill_rel).is_file():
                problems.append(
                    f"pack '{pack.name}': service '{sid}' skill_path missing: {skill_rel or '(empty)'}"
                )
        if not umbrella_path.is_file():
            problems.append(f"pack '{pack.name}': umbrella SKILL.md missing: {umbrella_path.relative_to(root)}")
            continue
        try:
            existing = umbrella_path.read_text(encoding="utf-8")
        except OSError as exc:
            problems.append(f"pack '{pack.name}': umbrella unreadable ({exc})")
            continue
        try:
            expected = generate_umbrella(registry, root.name, existing, {})
        except Exception as exc:
            problems.append(f"pack '{pack.name}': umbrella render failed ({exc})")
            continue
        if _services_table_section(expected) != _services_table_section(existing):
            problems.append(
                f"pack '{pack.name}': umbrella Services table does not match service-registry.json "
                f"(regen with the service-knowledge-sync specialist or umbrella_generator)"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CI committed-drift gate (read-only, seconds-budgeted).")
    parser.add_argument("--path", default=None, help="Repo root (default: git toplevel of cwd).")
    parser.add_argument(
        "--budget-seconds", type=float, default=DEFAULT_BUDGET_SECONDS,
        help=f"Seconds budget for the scan (default {DEFAULT_BUDGET_SECONDS:g}). Exceeding it fails the check.",
    )
    args = parser.parse_args(argv)
    t0 = time.monotonic()
    root = _project_root(args.path)

    packs = _find_umbrella_packs(root)
    if not packs:
        print("service-knowledge CI drift check: no service registry found — clean (non-service repo).")
        return 0

    try:
        drifted = scan_drift(str(root), use_gitnexus=False)
    except Exception as exc:
        print(f"::error::ci-drift-check: scan_drift raised {type(exc).__name__}: {str(exc)[:300]}", file=sys.stderr)
        return 2
    scan_ms = (time.monotonic() - t0) * 1000.0

    mismatches = _check_umbrellas(root)
    total_ms = (time.monotonic() - t0) * 1000.0

    budget_ms = max(0.0, float(args.budget_seconds)) * 1000.0
    over_budget = total_ms > budget_ms

    if drifted:
        services = sorted({str(d.get("service_id", "?")) for d in drifted})
        reasons: dict[str, int] = {}
        for d in drifted:
            key = str(d.get("reason", "?"))
            reasons[key] = reasons.get(key, 0) + 1
        reason_str = ", ".join(f"{k}×{v}" for k, v in sorted(reasons.items()))
        print(
            f"::error::ci-drift-check: committed drift detected — "
            f"{len(drifted)} file(s) across {', '.join(services)} ({reason_str})"
        )
        for d in drifted[:10]:
            print(f"::error file={d.get('file_path', '?')}::drifted [{d.get('service_id', '?')}] {d.get('reason', '?')}")
        if len(drifted) > 10:
            print(f"::error::ci-drift-check: ... and {len(drifted) - 10} more file(s)")
    for m in mismatches:
        print(f"::error::ci-drift-check: umbrella/registry mismatch — {m}")

    if over_budget:
        print(
            f"::error::ci-drift-check: over seconds budget "
            f"({total_ms:.0f}ms > {budget_ms:.0f}ms, scan {scan_ms:.0f}ms)"
        )
    else:
        print(f"ci-drift-check: finished in {total_ms:.0f}ms (scan {scan_ms:.0f}ms, budget {budget_ms:.0f}ms)")

    if drifted or mismatches or over_budget:
        if not drifted and not mismatches:
            print("ci-drift-check: FAIL (budget exceeded).")
        else:
            print("ci-drift-check: FAIL — reconcile with /updating-service-knowledge, then re-push.")
        return 1
    print(f"service-knowledge CI drift check: clean — no drift, umbrellas convergent ({total_ms:.0f}ms).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
