#!/usr/bin/env python3
"""
Cataloger — SessionStart hook for the service-knowledge system.

Reads the service registry (resolved via bootstrap) and prints a lightweight XML catalog block
to stdout for SessionStart injection (Progressive Disclosure — the agent learns which knowledge
sources exist without loading full skill bodies).

Reframed in PR3 (research §3.7 SessionStart): the block now advertises **operational knowledge
sources** with per-service index health, item count and verification coverage instead of the old
"Available expert personas" list. The legacy persona output stays available behind ``--legacy``
for backward compatibility; removal needs an explicit migration decision.

Index health is read straight from ``.xtrm/cache/service-knowledge.sqlite`` with stdlib sqlite3
(the cataloger is vendored standalone and must NOT import the pip-only index package):
  * ``ok``     — index built and its source_ref matches HEAD
  * ``stale``  — index built but HEAD has advanced past source_ref (rebuild advised)
  * ``absent`` — no index yet (run `service-knowledge index build`)
"""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

# bootstrap.py is a sibling in this consolidated scripts/ dir (no cross-skill hop).
sys.path.insert(0, str(Path(__file__).parent))

from bootstrap import (
    RegistryError,
    RootResolutionError,
    get_service_skill_path_str,
    list_services,
)

CACHE_REL = Path(".xtrm") / "cache" / "service-knowledge.sqlite"


def _project_root() -> str | None:
    import os
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return env
    try:
        result = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                                capture_output=True, text=True, check=True, timeout=5)
        return result.stdout.strip() or None
    except (subprocess.SubprocessError, OSError):
        return None


def _git_head(root: str) -> str:
    try:
        result = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"],
                                capture_output=True, text=True, check=False, timeout=5)
        return result.stdout.strip()
    except (subprocess.SubprocessError, OSError):
        return ""


def read_index_health(project_root: str) -> dict:
    """Index state + per-service item/verification stats via stdlib sqlite3 (no package dep)."""
    db = Path(project_root) / CACHE_REL
    health = {"state": "absent", "source_ref": "", "item_count": 0, "built_at": "",
              "per_service": {}, "head": _git_head(project_root)}
    if not db.exists():
        return health
    try:
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        state = conn.execute("SELECT source_ref, item_count, built_at FROM sk_index_state WHERE id=1").fetchone()
        if state is None:
            conn.close()
            return health
        health["source_ref"] = state["source_ref"] or ""
        health["item_count"] = state["item_count"] or 0
        health["built_at"] = state["built_at"] or ""
        head = health["head"]
        health["state"] = "ok" if (head and health["source_ref"] == head) else "stale"
        rows = conn.execute(
            "SELECT service_id, COUNT(*) AS n, "
            "SUM(CASE WHEN kind='claim' THEN 1 ELSE 0 END) AS claims, "
            "SUM(CASE WHEN kind='claim' AND verification LIKE '%verified%' THEN 1 ELSE 0 END) AS verified "
            "FROM sk_items WHERE status NOT IN ('superseded','invalidated') GROUP BY service_id"
        ).fetchall()
        for row in rows:
            health["per_service"][row["service_id"]] = {
                "items": row["n"], "claims": row["claims"] or 0, "verified": row["verified"] or 0,
            }
        conn.close()
    except sqlite3.Error:
        health["state"] = "absent"
    return health


def _verification_coverage(stats: dict) -> str:
    claims = stats.get("claims", 0)
    if not claims:
        return "n/a"
    return f"{stats.get('verified', 0)}/{claims}"


def generate_catalog(*, legacy: bool = False) -> str:
    """Generate the service catalog XML block (empty string on any failure — never break start)."""
    try:
        services = list_services()
    except (OSError, RegistryError, RootResolutionError, ValueError):
        return ""

    if not services:
        return ""

    if legacy:
        return _legacy_catalog(services)

    root = _project_root()
    health = read_index_health(root) if root else {"state": "absent", "per_service": {}, "source_ref": ""}

    lines = ["<project_service_catalog>", "Available operational knowledge sources:"]
    for service_id, data in sorted(services.items()):
        description = data.get("description", data.get("name", service_id))
        try:
            skill_path = data.get("skill_path") or get_service_skill_path_str(service_id)
        except RootResolutionError:
            skill_path = data.get("skill_path", f"{service_id}/SKILL.md")
        ref = str(data.get("last_sync_ref") or "")[:8] or "never"
        svc_stats = health.get("per_service", {}).get(service_id, {})
        items = svc_stats.get("items", 0)
        coverage = _verification_coverage(svc_stats)
        lines.append(
            f"- {service_id}: {description} (Path: {skill_path} | sync: {ref} | "
            f"items: {items} | verified: {coverage})"
        )

    ref8 = (health.get("source_ref") or "")[:8] or "none"
    lines.append(
        f"index_health: {health.get('state', 'absent')} (source_ref: {ref8}, "
        f"items: {health.get('item_count', 0)})"
    )
    lines.append("</project_service_catalog>")
    lines.append(
        "<instruction>Read a SKILL.md from its path to activate an expert. For ranked, "
        "citation-backed evidence use the knowledge_search MCP tool or "
        "`service-knowledge index query`.</instruction>"
    )
    return "\n".join(lines)


def _legacy_catalog(services: dict) -> str:
    """Pre-PR3 'Available expert personas' output — kept behind --legacy for backward compatibility."""
    lines = ["<project_service_catalog>", "Available expert personas:"]
    for service_id, data in sorted(services.items()):
        description = data.get("description", data.get("name", service_id))
        try:
            skill_path = data.get("skill_path") or get_service_skill_path_str(service_id)
        except RootResolutionError:
            skill_path = data.get("skill_path", f"{service_id}/SKILL.md")
        lines.append(f"- {service_id}: {description} (Path: {skill_path})")
    lines.append("</project_service_catalog>")
    lines.append("<instruction>To activate an expert, read its SKILL.md from the provided path.</instruction>")
    return "\n".join(lines)


def main() -> None:
    """Print catalog to stdout — injected as SessionStart additional context."""
    legacy = "--legacy" in sys.argv[1:]
    catalog = generate_catalog(legacy=legacy)
    if catalog:
        print(catalog)
    # Refresh the hook pre-filter's territory index once per session (XTRM-556). The
    # write is mtime/content keyed, so a clean registry costs no write at all. Failures
    # are silent: a stale index only costs the hook its fast path, never correctness.
    try:
        from build_territory_index import build as _build_territory_index

        _build_territory_index(os.environ.get("CLAUDE_PROJECT_DIR") or None)
    except Exception:
        pass
    # Silent if no services registered — don't break session start


if __name__ == "__main__":
    main()
