"""territory_gitignore_report flags territory globs that sweep in gitignored files (xtrm-br179).

scan_drift already DROPS gitignored candidates (xtrm-08i0b) so drift is correct, but a glob like
'dir/**/*' silently matching build/cache trees (__pycache__, target/, node_modules) is a footgun
worth surfacing so the operator narrows the pattern. This is the read-only lint behind the
'validate-territories' CLI.
"""
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import drift_detector

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)


def _repo(d: str, territory: list[str]) -> Path:
    root = Path(d)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    _git(root, "config", "user.email", "t@t.t")
    _git(root, "config", "user.name", "t")
    (root / "src").mkdir()
    (root / "src/app.py").write_text("x = 1\n", encoding="utf-8")        # tracked source
    (root / "src/__pycache__").mkdir()
    (root / "src/__pycache__/app.pyc").write_text("bytecode\n", encoding="utf-8")  # gitignored
    (root / ".gitignore").write_text("__pycache__/\n", encoding="utf-8")
    (root / "service-registry.json").write_text(json.dumps({"version": "1.0", "services": {
        "alpha": {"name": "Alpha", "territory": territory,
                  "skill_path": "skills/alpha/SKILL.md", "last_sync": "2024-01-01T00:00:00Z"}}}),
        encoding="utf-8")
    _git(root, "add", "src/app.py", ".gitignore", "service-registry.json")
    _git(root, "commit", "-qm", "init")
    return root


def test_recursive_glob_flags_gitignored_pyc():
    with TemporaryDirectory() as d:
        root = _repo(d, ["src/**/*"])
        report = drift_detector.territory_gitignore_report(str(root))
        assert len(report) == 1, report
        r = report[0]
        assert r["service_id"] == "alpha" and r["pattern"] == "src/**/*"
        assert r["ignored"] == 1 and r["tracked"] == 1
        assert any("__pycache__/app.pyc" in s for s in r["samples"])


def test_narrow_glob_is_clean():
    """A pattern that only matches tracked source produces no finding."""
    with TemporaryDirectory() as d:
        root = _repo(d, ["src/**/*.py"])
        assert drift_detector.territory_gitignore_report(str(root)) == []


def test_non_git_dir_returns_empty():
    with TemporaryDirectory() as d:
        plain = Path(d) / "loose"
        plain.mkdir()
        (plain / "service-registry.json").write_text('{"version":"1.0","services":{}}', encoding="utf-8")
        assert drift_detector.territory_gitignore_report(str(plain)) == []


def test_cli_validate_territories_reports_finding():
    with TemporaryDirectory() as d:
        root = _repo(d, ["src/**/*"])
        out = subprocess.run([sys.executable, str(SCRIPTS / "drift_detector.py"), "validate-territories"],
                             cwd=str(root), capture_output=True, text=True)
        assert out.returncode == 0, out.stderr
        assert "1 pattern(s) sweep in 1 gitignored file(s)" in out.stdout
        assert "src/**/*" in out.stdout
