"""OOM-footgun guards for drift_detector.scan_drift (xtrm-08i0b).

Two independent defenses, both exercised on the cheap mtime path (no gitnexus needed):
  1. .gitignore respect — candidates that are not git-tracked (build/vendor/cache trees
     swept in by filesystem globs) are dropped before any enrichment.
  2. Hard candidate cap — beyond MAX_ENRICH_CANDIDATES the scan falls back to mtime
     instead of fanning out a gitnexus subprocess per file.
"""
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _load():
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    import drift_detector  # type: ignore[import-not-found]
    return drift_detector


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, text=True, check=True).stdout.strip()


def _init_repo(d: str, territory: list[str]) -> Path:
    root = Path(d)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    _git(root, "config", "user.email", "t@t.t")
    _git(root, "config", "user.name", "t")
    reg_dir = root / ".xtrm/skills/user/packs/p1/service-skills"
    reg_dir.mkdir(parents=True)
    (reg_dir / "service-registry.json").write_text(json.dumps({
        "version": "1.0.0",
        "services": {"alpha": {
            "name": "Alpha", "territory": territory,
            "skill_path": ".xtrm/skills/user/packs/p1/service-skills/services/alpha/SKILL.md",
            # old last_sync so every freshly-written file counts as mtime-drifted
            "last_sync": "2020-01-01T00:00:00Z"}}}), encoding="utf-8")
    return root


def test_scan_drift_respects_gitignore():
    """A gitignored build artifact under the territory glob must NOT become a candidate."""
    with TemporaryDirectory() as d:
        root = _init_repo(d, ["src/**/*"])
        (root / "src").mkdir()
        (root / "src/tracked.py").write_text("x = 1\n", encoding="utf-8")
        (root / "src/build").mkdir()
        (root / "src/build/junk.py").write_text("# generated\n", encoding="utf-8")
        (root / ".gitignore").write_text("src/build/\n", encoding="utf-8")
        _git(root, "add", "src/tracked.py", ".gitignore",
             ".xtrm/skills/user/packs/p1/service-skills/service-registry.json")
        _git(root, "commit", "-qm", "init")

        drift_detector = _load()
        out = drift_detector.scan_drift(project_root=str(root), use_gitnexus=False)
        paths = {i["file_path"] for i in out}
        assert "src/tracked.py" in paths, f"tracked file must drift: {paths}"
        assert "src/build/junk.py" not in paths, f"gitignored build file must be dropped: {paths}"


def test_scan_drift_caps_enrichment(monkeypatch):
    """Over the cap, scan flips to mtime-only (gitnexus_status=disabled) — never fans out."""
    with TemporaryDirectory() as d:
        root = _init_repo(d, ["src/**/*.py"])
        (root / "src").mkdir()
        files = [f"src/f{n}.py" for n in range(3)]
        for f in files:
            (root / f).write_text("x = 1\n", encoding="utf-8")
        _git(root, "add", *files,
             ".xtrm/skills/user/packs/p1/service-skills/service-registry.json")
        _git(root, "commit", "-qm", "init")

        drift_detector = _load()
        monkeypatch.setattr(drift_detector, "MAX_ENRICH_CANDIDATES", 1)
        # use_gitnexus=True, but 3 candidates > cap(1) → forced mtime fallback BEFORE any
        # is_gitnexus_available probe, so every item is marked 'disabled', not enriched.
        out = drift_detector.scan_drift(project_root=str(root), use_gitnexus=True)
        assert len(out) == 3, f"all 3 tracked files drift: {out}"
        assert all(i["gitnexus_status"] == "disabled" for i in out), \
            f"cap must force mtime-only (disabled): {[i.get('gitnexus_status') for i in out]}"
