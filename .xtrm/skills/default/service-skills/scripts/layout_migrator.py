#!/usr/bin/env python3
"""
layout_migrator.py — one-time migration of a service-skills pack from the FLAT
layout to the UMBRELLA layout.

    FROM:  .xtrm/skills/user/packs/<pack>/<svc>/SKILL.md
           .xtrm/skills/user/packs/<pack>/service-registry.json
    TO:    .xtrm/skills/user/packs/<pack>/service-skills/services/<svc>/SKILL.md
           .xtrm/skills/user/packs/<pack>/service-skills/service-registry.json
           .xtrm/skills/user/packs/<pack>/service-skills/SKILL.md   (generated umbrella)

This is DISTINCT from skill_migrator.py: that edits a SKILL.md's headings; this
*moves files* and *relocates/rewrites the registry*, then generates the umbrella.

Hard-cut: after this runs, resolvers see only the new layout. Idempotent (re-run =
all-skipped, no mutation) and SAFE (never deletes a service dir before its move is
confirmed; refuses if a target already exists with divergent content).

Per-service SKILL.md content (incl. the SEMANTIC block) is moved verbatim — never
regenerated. CLI prints one line per service (``migrated:``/``skipped:``) so the
installer can summarize.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

# Sibling imports (consolidated scripts/ dir).
sys.path.insert(0, str(Path(__file__).parent))
from bootstrap import (  # noqa: E402  # type: ignore[import-not-found]
    RootResolutionError,
    get_pack_path,
    get_project_root,
)
from umbrella_generator import write_umbrella  # noqa: E402  # type: ignore[import-not-found]


class MigrationRefused(Exception):
    """Raised when migrating a service would overwrite divergent target content."""


def _read(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


def _new_skill_path_str(project_root: Path, pack: Path, service_id: str) -> str:
    new_md = pack / "service-skills" / "services" / service_id / "SKILL.md"
    try:
        return str(new_md.resolve(strict=False).relative_to(project_root.resolve())).replace(os.sep, "/")
    except ValueError:
        return str(new_md).replace(os.sep, "/")


def migrate_pack(project_root: Path, pack: Path, repo_name: str) -> dict[str, Any]:
    """Migrate one pack. Returns a result dict with per-service outcomes.

    Raises MigrationRefused (without partial side effects for the offending
    service) if a target exists with divergent content.
    """
    umbrella_dir = pack / "service-skills"
    services_dir = umbrella_dir / "services"
    old_registry = pack / "service-registry.json"
    new_registry = umbrella_dir / "service-registry.json"

    # Read whichever registry exists (new wins if already partially migrated).
    reg_src = new_registry if new_registry.exists() else old_registry
    if not reg_src.exists():
        return {"pack": pack.name, "status": "no-registry", "services": {}}
    registry: dict[str, Any] = json.loads(reg_src.read_text(encoding="utf-8"))
    services: dict[str, Any] = registry.get("services", {})

    outcomes: dict[str, str] = {}
    for service_id, info in services.items():
        old_dir = pack / service_id
        new_dir = services_dir / service_id

        if new_dir.exists():
            # Already in place. If the flat copy also lingers, it must match.
            if old_dir.exists() and old_dir.is_dir():
                if _read(old_dir / "SKILL.md") != _read(new_dir / "SKILL.md"):
                    raise MigrationRefused(
                        f"{service_id}: both {old_dir} and {new_dir} exist with divergent SKILL.md — refusing"
                    )
                shutil.rmtree(old_dir)  # safe: confirmed identical
                outcomes[service_id] = "deduped"
            else:
                outcomes[service_id] = "already-migrated"
        elif old_dir.exists() and old_dir.is_dir():
            services_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old_dir), str(new_dir))  # rename — atomic on same fs
            outcomes[service_id] = "migrated"
        else:
            outcomes[service_id] = "missing-source"

        info["skill_path"] = _new_skill_path_str(project_root, pack, service_id)

    # Relocate the registry under the umbrella with rewritten skill_paths.
    umbrella_dir.mkdir(parents=True, exist_ok=True)
    new_registry.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    if old_registry.exists() and old_registry.resolve() != new_registry.resolve():
        old_registry.unlink()

    # Generate the umbrella (preserves any existing SEMANTIC block).
    umbrella_changed = write_umbrella(umbrella_dir / "SKILL.md", registry, repo_name)

    return {
        "pack": pack.name,
        "status": "ok",
        "services": outcomes,
        "umbrella_written": umbrella_changed,
        "registry": str(new_registry),
    }


def demote_shadowing_registries(project_root: Path) -> list[str]:
    """Remove/flag the stale repo-root + legacy `.claude/skills` registries that
    would otherwise SHADOW the migrated umbrella registry. Symlinks (stale pointers)
    are removed; real files are left in place but reported so nothing is silently
    lost. Returns human-readable notes."""
    notes: list[str] = []
    for label, candidate in (
        ("root", project_root / "service-registry.json"),
        ("legacy", project_root / ".claude" / "skills" / "service-registry.json"),
    ):
        if candidate.is_symlink():
            candidate.unlink()
            notes.append(f"removed stale {label} registry symlink: {candidate}")
        elif candidate.exists():
            notes.append(
                f"WARNING: real {label} registry still present at {candidate} — the umbrella "
                f"registry is now canonical; review and remove this duplicate manually"
            )
    return notes


def main() -> None:
    args = sys.argv[1:]
    project_root_str = os.environ.get("CLAUDE_PROJECT_DIR")
    if not project_root_str:
        try:
            project_root_str = get_project_root()
        except RootResolutionError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    project_root = Path(project_root_str)
    repo_name = args[0] if args else project_root.name

    pack = get_pack_path(project_root_str)
    if pack is None:
        print("Error: unable to resolve pack path. Set XTRM_PACK or leave only one pack under .xtrm/skills/user/packs.", file=sys.stderr)
        sys.exit(1)

    try:
        result = migrate_pack(project_root, pack, repo_name)
    except MigrationRefused as e:
        print(f"refused: {e}", file=sys.stderr)
        sys.exit(2)

    if result["status"] == "no-registry":
        print(f"skipped: {pack.name} (no service-registry.json)")
        sys.exit(0)
    for sid, outcome in result["services"].items():
        prefix = "migrated" if outcome in ("migrated", "deduped") else "skipped"
        print(f"{prefix}: {sid} ({outcome})")
    print(f"registry: {result['registry']}")
    print(f"umbrella: {'written' if result['umbrella_written'] else 'unchanged'}")
    for note in demote_shadowing_registries(project_root):
        print(note)
    sys.exit(0)


if __name__ == "__main__":
    main()
