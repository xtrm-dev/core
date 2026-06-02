"""_gitnexus_repo_name must resolve the indexed (main-worktree) repo label, not the
per-worktree basename (xtrm-vvhfs).

The service-skills-sync librarian ALWAYS runs in an sp-auto-provisioned linked worktree.
Before the fix, get_project_root() -> worktree dir -> basename injected as gitnexus --repo,
which gitnexus never indexed -> every gitnexus call failed -> drift fell back to mtime-only
for the one specialist that most needs semantic tiering.
"""
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import bootstrap


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, text=True, check=True).stdout.strip()


def _init_main(d: str) -> Path:
    main = Path(d) / "market-data"
    main.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=main, check=True)
    _git(main, "config", "user.email", "t@t.t")
    _git(main, "config", "user.name", "t")
    (main / "f.txt").write_text("x\n", encoding="utf-8")
    _git(main, "add", "f.txt")
    _git(main, "commit", "-qm", "init")
    return main


def test_main_checkout_returns_repo_basename(monkeypatch):
    monkeypatch.delenv("GITNEXUS_REPO", raising=False)
    with TemporaryDirectory() as d:
        main = _init_main(d)
        assert bootstrap._gitnexus_repo_name(str(main)) == "market-data"


def test_worktree_resolves_to_main_basename_not_worktree_dir(monkeypatch):
    """The crux: from inside a linked worktree, the label is the MAIN repo basename."""
    monkeypatch.delenv("GITNEXUS_REPO", raising=False)
    with TemporaryDirectory() as d:
        main = _init_main(d)
        wt = Path(d) / "market-data-uh1r-service-skills-sync"
        _git(main, "worktree", "add", "-q", str(wt))
        # Sanity: the naive basename would be the worktree dir name.
        assert wt.name != main.name
        assert bootstrap._gitnexus_repo_name(str(wt)) == "market-data", \
            "worktree must resolve to the indexed main-repo label, not its own dir name"


def test_gitnexus_repo_env_override_wins(monkeypatch):
    monkeypatch.setenv("GITNEXUS_REPO", "explicit-label")
    with TemporaryDirectory() as d:
        main = _init_main(d)
        assert bootstrap._gitnexus_repo_name(str(main)) == "explicit-label"


def test_non_git_dir_falls_back_to_basename(monkeypatch):
    monkeypatch.delenv("GITNEXUS_REPO", raising=False)
    with TemporaryDirectory() as d:
        plain = Path(d) / "loose-checkout"
        plain.mkdir()
        assert bootstrap._gitnexus_repo_name(str(plain)) == "loose-checkout"
