"""Catalogued != verified-synced (xtrm-008tr).

Two invariants the field incident (mercury-market-data: 16 services bulk-stamped
last_sync=now with no last_sync_ref -> drift scan returned 0 despite 20+ changed files)
proves are required:

  1. register_service MUST NOT stamp last_sync. Registration catalogues a service; only a
     verified audit (drift_detector.update_sync_time) may claim a sync, and it stamps
     last_sync_ref atomically alongside.
  2. scan_drift MUST surface a service that has never been verified-synced (no/sentinel
     last_sync) as drift (needs initial sync) rather than silently skipping it — skipping is
     exactly how the timestamp-less bulk catalog masked real drift.
"""
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import bootstrap
import drift_detector


def test_register_service_does_not_stamp_last_sync(tmp_path: Path):
    bootstrap.register_service("svc", "Svc", ["src/**/*"], "skills/svc/SKILL.md",
                               project_root=str(tmp_path))
    svc = bootstrap.get_service("svc", str(tmp_path))
    assert svc is not None
    # Catalogued, not synced: neither field is faked at registration.
    assert "last_sync" not in svc, "registration must not claim a sync"
    assert "last_sync_ref" not in svc


def _repo_with_service(d: str, *, last_sync) -> Path:
    """git repo + a tracked src file + a registry service whose last_sync is `last_sync`
    (None => key omitted entirely, mimicking a freshly catalogued service)."""
    root = Path(d)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    for k, v in (("user.email", "t@t.t"), ("user.name", "t")):
        subprocess.run(["git", "-C", str(root), "config", k, v], check=True)
    (root / "src").mkdir()
    (root / "src/app.py").write_text("x = 1\n", encoding="utf-8")
    svc: dict = {"name": "Alpha", "territory": ["src/**/*"], "skill_path": "skills/alpha/SKILL.md"}
    if last_sync is not None:
        svc["last_sync"] = last_sync
    (root / "service-registry.json").write_text(
        json.dumps({"version": "1.0", "services": {"alpha": svc}}), encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "add", "src/app.py", "service-registry.json"], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-qm", "init"], check=True)
    return root


def test_scan_surfaces_service_with_no_last_sync():
    """No last_sync at all (catalogued-only) -> the whole territory is surfaced as drift."""
    with TemporaryDirectory() as d:
        root = _repo_with_service(d, last_sync=None)
        out = drift_detector.scan_drift(project_root=str(root), use_gitnexus=False)
        hits = {i["file_path"]: i for i in out}
        assert "src/app.py" in hits, f"never-synced service must surface, not be skipped: {hits}"
        assert hits["src/app.py"]["never_synced"] is True


def test_scan_surfaces_never_sentinel_service():
    """The 'never' string sentinel is also never-synced -> surfaced, not skipped."""
    with TemporaryDirectory() as d:
        root = _repo_with_service(d, last_sync="never")
        out = drift_detector.scan_drift(project_root=str(root), use_gitnexus=False)
        assert any(i["file_path"] == "src/app.py" and i["never_synced"] for i in out), \
            "the 'never' sentinel must be treated as needing an initial sync"


def test_scan_respects_a_real_future_sync():
    """Sanity: a genuine verified sync in the future is NOT never-synced and masks nothing
    falsely — a file committed before that sync does not drift, and never_synced is False."""
    with TemporaryDirectory() as d:
        root = _repo_with_service(d, last_sync="2999-01-01T00:00:00Z")
        out = drift_detector.scan_drift(project_root=str(root), use_gitnexus=False)
        assert out == [], f"file older than a future sync must not drift: {out}"
