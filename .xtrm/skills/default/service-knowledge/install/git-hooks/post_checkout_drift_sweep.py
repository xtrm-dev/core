#!/usr/bin/env python3
"""
Post-checkout service-knowledge touches-gated marker (B3, xtrm-646).

Marker-only: on a checkout that touches service-knowledge, write/refresh the
pending marker at ``.xtrm/.service-knowledge-drift-pending`` and print a
one-paragraph notice. Otherwise exit silently with no marker change.

Contract (XTRM-641 §3-§4, B2 touches gate carried over):
  - Range from argv: ``post-checkout <prev HEAD> <new HEAD> <branch-flag>``.
    ``branch-flag`` 1 = branch checkout, 0 = file checkout (HEAD unmoved;
    prev == new, so the gate below exits silently on its own).
  - Fresh clone / new worktree: ``prev`` is the null SHA (all zeros) — write
    ``reason=fresh-cache`` with no service list. Layer 1 rebuilds on first
    query. Never an mtime/scan_detector scan here: fresh checkouts would
    false-positive storm (every mtime newer than ``last_sync``).
  - Missing/unparsable argv or a non-null but unresolvable range:
    ``reason=range-unknown`` marker, never a scan or rebuild.
  - Touches gate on ``prev..new``: registry / skill-body / umbrella
    paths OR tracked files matching a registered territory glob. Tracked-only:
    ``git diff --name-only`` intersected with ``git ls-files`` — untracked
    agent scratch dirs (``.pi/``, ``.specialists/``) can never match.
  - Marker-only: no index rebuild, no mtime/scan_detector scan, no gitnexus
    fan-out. The marker carries ``trigger, range, reason, services,
    timestamp``; an existing marker keeps its earliest range start.
  - Reasons: ``ref-range`` (resolved diff touched), ``initial-sync-needed``
    (touched service never verified-synced), ``fresh-cache`` (null prev:
    clone/worktree creation), ``range-unknown`` (no range resolvable).
    ``mtime-heuristic`` is a schema tag reserved for the drift-CLI fallback
    writer; this hook never emits it.
  - Fast and non-interactive: zero heavy imports, only
    ``git rev-parse`` / ``git diff --name-only`` / ``git ls-files`` (<100ms
    each). Target <1s no-touch / <2s touch. Always exits 0 — hooks must never
    fail a checkout. Never reads stdin (the checkout protocol carries no SHAs
    there; SHAs arrive via argv).
  - No auto-reconcile (B7, XTRM-650): the opt-in ``sp script``
    service-knowledge-sync subprocess path is cut. Marker + next-session
    reconciliation only — run /updating-service-knowledge in the next session.
"""
from __future__ import annotations

import fnmatch
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MARKER_REL = Path(".xtrm") / ".service-knowledge-drift-pending"

TRIGGER = "post-checkout"

# Marker reason tags (B2 schema + B3 fresh-cache). This hook emits ref-range /
# initial-sync-needed / fresh-cache / range-unknown only; mtime-heuristic is
# reserved for the drift-CLI fallback writer.
REASON_REF_RANGE = "ref-range"
REASON_INITIAL_SYNC = "initial-sync-needed"
REASON_FRESH = "fresh-cache"
REASON_RANGE_UNKNOWN = "range-unknown"
REASON_MTIME = "mtime-heuristic"

_NULL_SHAS = {"0" * 40, "0" * 64}

_RESERVED_PACKS = {"default", "optional", "user", "active", "local-legacy"}


def _project_root() -> Path:
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return Path(env)
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if r.returncode == 0 and r.stdout.strip():
            return Path(r.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    return Path.cwd()


def _git(root: Path, args: list[str], timeout: int = 5) -> subprocess.CompletedProcess[str] | None:
    """Run a git command; return None on any failure (never raises)."""
    try:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _is_null_sha(ref: str) -> bool:
    """Null SHAs (all zeros, any length git emits) mean fresh clone/worktree."""
    s = ref.strip().lower()
    return bool(s) and set(s) == {"0"}


def _checkout_range(argv: list[str]) -> tuple[str | None, str | None, str, str]:
    """Parse post-checkout argv (prev, new, branch-flag).

    Returns (prev, new, flag, status) where status is one of:
      "fresh"   — prev is the null SHA: clone / worktree creation.
      "range"   — both SHAs present; gate on prev..new (prev == new exits
                  silently in main: file checkout with HEAD unmoved).
      "unknown" — argv missing/unparsable; caller writes range-unknown.
    """
    if len(argv) < 4:
        return (None, None, "", "unknown")
    prev, new, flag = argv[1].strip(), argv[2].strip(), argv[3].strip()
    if not prev or not new:
        return (None, None, flag, "unknown")
    if _is_null_sha(prev):
        return (prev, new, flag, "fresh")
    if _is_null_sha(new):
        # Checking out to nowhere: cannot scope a diff.
        return (prev, new, flag, "unknown")
    return (prev, new, flag, "range")


def _tracked_files(root: Path) -> set[str] | None:
    """Tracked paths (relative POSIX); None when git is unavailable."""
    r = _git(root, ["ls-files", "-z"], timeout=10)
    if r is None or r.returncode != 0:
        return None
    # git -z separates with NUL; stdout is str here (text=True).
    return {p for p in r.stdout.split("\0") if p}


def _diff_files(root: Path, prev: str, new: str) -> list[str] | None:
    """Names changed in prev..new; None on git failure."""
    r = _git(root, ["diff", "--name-only", prev, new, "--"], timeout=10)
    if r is None or r.returncode != 0:
        return None
    return [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]


def _load_registries(root: Path) -> list[tuple[Path, dict]]:
    """All (registry_abs_path, registry_dict) present; empty when none."""
    candidates: list[Path] = []
    for packs_name in (root / ".xtrm" / "skills", root / ".xtrm" / "skills" / "user" / "packs"):
        if not packs_name.is_dir():
            continue
        try:
            packs = sorted(p for p in packs_name.iterdir() if p.is_dir() and p.name not in _RESERVED_PACKS)
        except OSError:
            continue
        for pack in packs:
            for name in ("service-knowledge", "service-skills"):
                reg = pack / name / "service-registry.json"
                if reg.is_file():
                    candidates.append(reg)
                    break
            else:
                flat = pack / "service-registry.json"
                if flat.is_file():
                    candidates.append(flat)
    for extra in (root / "service-registry.json", root / ".claude" / "skills" / "service-registry.json"):
        if extra.is_file() and extra not in candidates:
            candidates.append(extra)
    out: list[tuple[Path, dict]] = []
    for reg in candidates:
        try:
            data = json.loads(reg.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            out.append((reg, data))
    return out


def _has_registry(root: Path) -> bool:
    return bool(_load_registries(root))


def _territory_base(pattern: str) -> str:
    return pattern.replace("/**/*", "").replace("/**", "").replace("/*", "").rstrip("/")


def _path_in_territory(path: str, patterns: list[str]) -> bool:
    """Pure path match (no filesystem scan): fnmatch + base-prefix fallback."""
    for pattern in patterns:
        if not pattern:
            continue
        try:
            if fnmatch.fnmatch(path, pattern):
                return True
        except Exception:
            continue
        base = _territory_base(pattern)
        if base and (path == base or path.startswith(base + "/")):
            return True
    return False


def _strip_dot_prefix(path: str) -> str:
    """Strip one leading ./ prefix (lstrip would eat the .xtrm dot)."""
    norm = path.strip()
    if norm.startswith("./"):
        return norm[2:]
    return norm


def _touches_gate(changed: set[str], registries: list[tuple[Path, dict]], root: Path) -> tuple[bool, set[str]]:
    """Touches when a changed path is a registry/skill-body/umbrella path or
    matches a registered territory glob. Returns (touched, services)."""
    # Index registries by relative POSIX path for O(1) changed-path lookup.
    registry_rels: dict[str, dict] = {}
    skill_rel_to_service: dict[str, str] = {}
    umbrella_services: dict[str, dict] = {}
    service_territories: dict[str, list[str]] = {}
    for reg_abs, data in registries:
        try:
            rel = reg_abs.relative_to(root).as_posix()
        except ValueError:
            rel = reg_abs.name
        registry_rels[rel] = data
        services = data.get("services", {}) if isinstance(data.get("services", {}), dict) else {}
        # Umbrella SKILL.md siblings of the registry (<pack>/<umbrella>/SKILL.md).
        try:
            umbrella_services[(reg_abs.parent / "SKILL.md").relative_to(root).as_posix()] = services
        except ValueError:
            pass
        for sid, info in services.items():
            if not isinstance(info, dict):
                continue
            sp = info.get("skill_path")
            if isinstance(sp, str) and sp:
                skill_rel_to_service[_strip_dot_prefix(sp)] = sid
            terr = info.get("territory", [])
            if isinstance(terr, list):
                service_territories[sid] = [str(p) for p in terr if isinstance(p, str) and p]
    # Resolve umbrella rels (kept as absolute above for parent math).
    umbrella_rel_strs: set[str] = set(umbrella_services.keys())
    touched_services: set[str] = set()
    touched = False
    for path in changed:
        norm = _strip_dot_prefix(path)
        if norm in registry_rels:
            touched = True
            data = registry_rels[norm]
            services = data.get("services", {})
            if isinstance(services, dict):
                touched_services.update(str(k) for k in services.keys())
            continue
        if norm in umbrella_rel_strs:
            touched = True
            # Umbrella change potentially affects every service in its pack.
            services = umbrella_services.get(norm, {})
            if isinstance(services, dict):
                touched_services.update(str(k) for k in services.keys())
            continue
        if norm in skill_rel_to_service:
            touched = True
            touched_services.add(skill_rel_to_service[norm])
            continue
        # Skill-body by convention (<pack>/.../services/<id>/SKILL.md) even when
        # the registry skill_path differs textually.
        if norm.endswith("SKILL.md") and "/services/" in norm:
            seg = norm.split("/services/")[-1].split("/")[0]
            if seg:
                # Attribute only when the service id is registered somewhere.
                if seg in service_territories:
                    touched = True
                    touched_services.add(seg)
                    continue
        for sid, patterns in service_territories.items():
            if patterns and _path_in_territory(norm, patterns):
                touched = True
                touched_services.add(sid)
                break
    return (touched, touched_services)


def _touched_never_synced(services: set[str], registries: list[tuple[Path, dict]]) -> bool:
    """True when any touched service was catalogued but never verified-synced."""
    by_id: dict[str, dict] = {}
    for _reg, data in registries:
        svcs = data.get("services", {})
        if isinstance(svcs, dict):
            for sid, info in svcs.items():
                if isinstance(info, dict):
                    by_id.setdefault(str(sid), info)
    for sid in services:
        info = by_id.get(sid, {})
        ref = info.get("last_sync_ref")
        sync = info.get("last_sync")
        if not (isinstance(ref, str) and ref) and not (isinstance(sync, str) and sync):
            return True
    return False


def _existing_range_start(root: Path) -> str | None:
    """Live re-read: earliest range start preserved across refreshes."""
    try:
        text = (root / MARKER_REL).read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if line.strip().startswith("range:"):
            val = line.split(":", 1)[1].strip()
            if not val or val == "unknown":
                return None
            return val.split("..")[0].strip() or None
    return None


def _write_marker(
    root: Path,
    *,
    orig: str | None,
    head: str | None,
    reason: str,
    services: set[str] | list[str],
    files: int,
) -> Path:
    """Write/refresh the canonical pending marker (live preserve-earliest-range)."""
    marker = root / MARKER_REL
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    short = lambda ref: ref[:7] if ref else ""
    if orig and head and not _is_null_sha(orig):
        new_start, new_end = short(orig), short(head)
    else:
        new_start, new_end = "", ""
    prev_start = _existing_range_start(root)
    if new_start and new_end:
        start = prev_start if (prev_start and prev_start != new_start) else new_start
        range_str = f"{start}..{new_end}"
    elif prev_start and new_end:
        range_str = f"{prev_start}..{new_end}"
    else:
        range_str = "unknown"
    svc_list = sorted(set(services))
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    lines = [
        f"service-knowledge drift detected post-checkout (range {range_str})\n",
        f"trigger: {TRIGGER}\n",
        f"range: {range_str}\n",
        f"reason: {reason}\n",
        f"services: {', '.join(svc_list) if svc_list else '(none)'}\n",
        f"files: {files}\n",
        f"timestamp: {timestamp}\n",
        "action: run /updating-service-knowledge (service-knowledge-sync) to reconcile + stamp last_sync_ref\n",
    ]
    try:
        marker.write_text("".join(lines), encoding="utf-8")
    except OSError:
        pass
    return marker


def _notice(range_str: str, reason: str, services: set[str] | list[str], files: int) -> None:
    """One-paragraph notice on touch (marker already written)."""
    svc_list = sorted(set(services))
    svc_txt = ", ".join(svc_list) if svc_list else "(services unknown — range could not be scoped)"
    print()
    print("⚠  service-knowledge drift pending at the post-checkout reconciliation point.")
    print(f"   range {range_str} · reason {reason} · {files} touched file(s) across: {svc_txt}")
    print("   Reconcile with /updating-service-knowledge (the service-knowledge-sync specialist),")
    print(f"   which syncs the drifted SKILL.md and advances last_sync_ref. (pending marker: {MARKER_REL.as_posix()})")
    print()


def _write_unknown_and_notice(root: Path) -> None:
    """Fallback marker when no range is resolvable (never a scan or rebuild)."""
    _write_marker(root, orig=None, head=None, reason=REASON_RANGE_UNKNOWN, services=set(), files=0)
    print()
    print("⚠  service-knowledge drift pending at the post-checkout reconciliation point.")
    print(f"   range unknown · reason {REASON_RANGE_UNKNOWN} · checkout range could not be scoped; marker written for reconciler triage.")
    print("   Reconcile with /updating-service-knowledge (the service-knowledge-sync specialist),")
    print(f"   which scopes the drift and advances last_sync_ref. (pending marker: {MARKER_REL.as_posix()})")
    print()


def _write_fresh_and_notice(root: Path, head: str | None) -> None:
    """Fresh-cache marker for clone/worktree creation: no service list, no scan.

    A fresh checkout has no meaningful diff to gate on and every mtime is
    newer than ``last_sync`` — gating or scanning here would false-positive
    storm. The marker tells Layer 1/the reconciler the cache is cold.
    """
    short = head[:7] if head and not _is_null_sha(head) else ""
    _write_marker(root, orig=None, head=None, reason=REASON_FRESH, services=set(), files=0)
    print()
    print("⚠  service-knowledge cache is cold after checkout (fresh clone or new worktree).")
    print(f"   range unknown · reason {REASON_FRESH}{' · checked out ' + short if short else ''} · marker written; the index rebuilds on first query.")
    print("   Reconcile with /updating-service-knowledge (the service-knowledge-sync specialist),")
    print(f"   which scopes the drift and advances last_sync_ref. (pending marker: {MARKER_REL.as_posix()})")
    print()


def main(argv: list[str] | None = None) -> int:
    # Hooks must never fail the checkout: every path returns 0.
    try:
        root = _project_root()
    except Exception:
        return 0
    try:
        registries = _load_registries(root)
    except Exception:
        return 0
    if not registries:
        return 0

    try:
        prev, new, _flag, status = _checkout_range(sys.argv if argv is None else argv)
    except Exception:
        return 0
    if status == "fresh":
        try:
            _write_fresh_and_notice(root, new)
        except Exception:
            pass
        return 0
    if status == "unknown" or not prev or not new:
        try:
            _write_unknown_and_notice(root)
        except Exception:
            pass
        return 0
    if prev == new:
        # File checkout (branch-flag 0): HEAD unmoved, nothing landed.
        return 0

    try:
        tracked = _tracked_files(root)
        diff = _diff_files(root, prev, new)
    except Exception:
        return 0
    if diff is None or tracked is None:
        try:
            _write_unknown_and_notice(root)
        except Exception:
            pass
        return 0

    try:
        changed = {p for p in diff if p in tracked}
    except Exception:
        return 0
    if not changed:
        return 0

    try:
        touched, services = _touches_gate(changed, registries, root)
    except Exception:
        return 0
    if not touched:
        return 0

    try:
        reason = REASON_INITIAL_SYNC if _touched_never_synced(services, registries) else REASON_REF_RANGE
    except Exception:
        reason = REASON_REF_RANGE
    try:
        range_str = f"{prev[:7]}..{new[:7]}"
        _write_marker(root, orig=prev, head=new, reason=reason, services=services, files=len(changed))
        _notice(range_str, reason, services, len(changed))
    except Exception:
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
