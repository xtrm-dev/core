from __future__ import annotations

import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "audit_agent_docs.py"
spec = importlib.util.spec_from_file_location("audit_agent_docs", SCRIPT)
audit_agent_docs = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(audit_agent_docs)


def write_doc(repo: Path, body: str) -> None:
    (repo / "CLAUDE.md").write_text(body, encoding="utf8")


def test_flags_docs_that_start_with_managed_block(tmp_path: Path) -> None:
    write_doc(
        tmp_path,
        """<!-- xtrm:start -->
# XTRM workflow
<!-- xtrm:end -->
""",
    )

    result = audit_agent_docs.audit_repo(tmp_path)["docs"]["CLAUDE.md"]

    assert result["repo_identity"]["status"] == "missing"
    assert "Repo Identity" in "; ".join(result["recommendations"])


def test_preserves_long_substantive_identity_overview(tmp_path: Path) -> None:
    overview_lines = [
        "# Mercury Platform — Infra (central gateway + observability)",
        "This repo owns the central gateway and observability surface for the platform, so a fresh agent knows where traffic, metrics, and read-only tool surfaces converge.",
        "",
    ]
    overview_lines.extend(
        f"Layer {idx}: this explanatory prose is deliberately useful platform context rather than copied CLI manual boilerplate."
        for idx in range(1, 120)
    )
    overview_lines.extend(
        [
            "<!-- xtrm:start -->",
            "## XTRM workflow",
            "Use `bd ready` and `bd update task --claim`.",
            "<!-- xtrm:end -->",
        ]
    )
    write_doc(tmp_path, "\n".join(overview_lines))

    result = audit_agent_docs.audit_repo(tmp_path)["docs"]["CLAUDE.md"]

    assert result["repo_identity"]["status"] == "ok"
    assert result["size_budget"]["repo_identity_lines"] >= 100
    assert not any(rec.startswith("trim") or rec.startswith("rewrite") for rec in result["recommendations"])


def test_operational_quick_reference_is_not_bloat(tmp_path: Path) -> None:
    write_doc(
        tmp_path,
        """# Example — Agent Guide
This repository runs a small service and this sentence gives enough context for a new agent.

## Quick Reference
- `bd ready` — inspect work.
- `bd update task --claim` — claim before edits.
- `make test` — run tests.
- `make up` — start local services.
""",
    )

    result = audit_agent_docs.audit_repo(tmp_path)["docs"]["CLAUDE.md"]

    assert result["command_details"]["manual_command_refs"] == 0
    assert not result["bloat_headings"]
    assert result["recommendations"] == ["ok: no major bloat signals"]


def test_repo_config_extends_stale_terms(tmp_path: Path) -> None:
    (tmp_path / ".xtrm").mkdir()
    (tmp_path / ".xtrm" / "agent-docs.toml").write_text('stale_terms = ["OldMercury"]\n', encoding="utf8")
    write_doc(
        tmp_path,
        """# Example — Agent Guide
This repository runs a small service and this sentence gives enough context for a new agent.
OldMercury should be renamed.
""",
    )

    result = audit_agent_docs.audit_repo(tmp_path)["docs"]["CLAUDE.md"]

    assert "OldMercury" in result["stale_terms"]
    assert "remove or rename stale project terms" in result["recommendations"]


def test_json_result_is_serializable(tmp_path: Path) -> None:
    write_doc(
        tmp_path,
        """# Example — Agent Guide
This repository runs a small service and this sentence gives enough context for a new agent.
""",
    )

    result = audit_agent_docs.audit_repo(tmp_path)

    json.dumps(result)
