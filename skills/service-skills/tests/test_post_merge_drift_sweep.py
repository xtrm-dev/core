"""Post-merge drift sweep gating + trigger (xtrm-jcmub).

The sweep is the proactive backstop that fires on a default-branch merge: it must
no-op cleanly outside a service repo and off the default branch, and on real drift
it must surface a notice and drop the pending marker (without spawning a specialist).
"""
import json
import sys
from pathlib import Path


_HOOK_DIR = Path(__file__).resolve().parents[1] / "install" / "git-hooks"
sys.path.insert(0, str(_HOOK_DIR))

import post_merge_drift_sweep as sweep  # noqa: E402

MARKER_REL = Path(".xtrm") / ".service-skills-drift-pending"


def _write_root_registry(root: Path) -> None:
    (root / "service-registry.json").write_text(
        json.dumps({
            "version": "1.0.0",
            "services": {
                "alpha": {
                    "name": "Alpha",
                    "territory": ["skills/alpha/**/*"],
                    "skill_path": "skills/alpha/SKILL.md",
                    "last_sync": "2024-01-01T00:00:00Z",
                }
            },
        }),
        encoding="utf-8",
    )
    f = root / "skills/alpha/README.md"
    f.parent.mkdir(parents=True)
    f.write_text("alpha drift", encoding="utf-8")
    f.touch()


def test_no_registry_is_silent_noop(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    rc = sweep.main()
    assert rc == 0
    assert not (tmp_path / MARKER_REL).exists()
    assert capsys.readouterr().out.strip() == ""


def test_feature_branch_is_skipped(tmp_path: Path, monkeypatch, capsys):
    _write_root_registry(tmp_path)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    monkeypatch.setattr(sweep, "_current_branch", lambda root: "feature/widget")
    monkeypatch.setattr(sweep, "_default_branch", lambda root: "main")
    rc = sweep.main()
    assert rc == 0
    # Branch gate fires before the scan, so no marker.
    assert not (tmp_path / MARKER_REL).exists()


def test_default_branch_drift_writes_marker_and_notice(tmp_path: Path, monkeypatch, capsys):
    _write_root_registry(tmp_path)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    monkeypatch.setattr(sweep, "_current_branch", lambda root: "main")
    monkeypatch.setattr(sweep, "_default_branch", lambda root: "main")
    # No last_sync_ref in the registry → drift_detector uses the mtime fallback and
    # reports the territory file as drifted.
    rc = sweep.main()
    assert rc == 0
    marker = tmp_path / MARKER_REL
    assert marker.exists(), "drift must drop the pending marker"
    body = marker.read_text()
    assert "alpha" in body
    assert "updating-service-skills" in body
    out = capsys.readouterr().out
    assert "service-skills drift detected" in out


def test_default_branch_no_drift_is_silent(tmp_path: Path, monkeypatch, capsys):
    # Registry with a service whose territory matches nothing → no drift.
    (tmp_path / "service-registry.json").write_text(
        json.dumps({"version": "1.0.0", "services": {
            "alpha": {"name": "Alpha", "territory": ["nonexistent/**/*"],
                      "skill_path": "skills/alpha/SKILL.md", "last_sync": "2024-01-01T00:00:00Z"}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    monkeypatch.setattr(sweep, "_current_branch", lambda root: "main")
    monkeypatch.setattr(sweep, "_default_branch", lambda root: "main")
    rc = sweep.main()
    assert rc == 0
    assert not (tmp_path / MARKER_REL).exists()
    assert capsys.readouterr().out.strip() == ""
