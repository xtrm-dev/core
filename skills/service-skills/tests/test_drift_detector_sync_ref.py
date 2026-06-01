"""Regression: `drift_detector.py sync <id>` must stamp last_sync_ref to HEAD (xtrm-lg9km).

The CLI path calls update_sync_time(service_id) with project_root=None. Before the fix
that None was passed straight to _git_head -> `git -C None ...` raised -> last_sync_ref
was silently stored as "", which forced scan to the mtime fallback for every service.
"""
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, text=True, check=True).stdout.strip()


def test_cli_sync_stamps_nonempty_last_sync_ref_to_head():
    with TemporaryDirectory() as d:
        root = Path(d)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        _git(root, "config", "user.email", "t@t.t")
        _git(root, "config", "user.name", "t")
        # Minimal service repo: a pack umbrella registry with one service.
        reg_dir = root / ".xtrm/skills/user/packs/p1/service-skills"
        reg_dir.mkdir(parents=True)
        (reg_dir / "service-registry.json").write_text(json.dumps({
            "version": "1.0.0",
            "services": {"alpha": {"name": "Alpha", "territory": ["src/**/*"],
                                   "skill_path": ".xtrm/skills/user/packs/p1/service-skills/services/alpha/SKILL.md",
                                   "last_sync": "never"}}}), encoding="utf-8")
        (root / "src").mkdir()
        (root / "src/x.py").write_text("x=1\n", encoding="utf-8")
        _git(root, "add", "-A")
        _git(root, "commit", "-qm", "init")
        head = _git(root, "rev-parse", "HEAD")

        # The real CLI path: project_root is resolved from cwd (None argument).
        r = subprocess.run([sys.executable, str(SCRIPTS / "drift_detector.py"), "sync", "alpha"],
                           cwd=str(root), capture_output=True, text=True)
        assert r.returncode == 0, r.stderr

        reg = json.loads((reg_dir / "service-registry.json").read_text())
        ref = reg["services"]["alpha"].get("last_sync_ref")
        assert ref, f"last_sync_ref must be stamped (non-empty), got {ref!r}"
        assert ref == head, f"last_sync_ref must equal HEAD: {ref!r} != {head!r}"
