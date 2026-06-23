import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import bootstrap
from bootstrap import get_registry_path


def test_pack_only_registry(tmp_path: Path):
    reg = tmp_path / ".xtrm/skills/user/packs/mercury/service-registry.json"
    reg.parent.mkdir(parents=True)
    reg.write_text("{}")
    assert get_registry_path(str(tmp_path)) == reg


def test_canonical_xtrm_wins_over_root_legacy_shadow(tmp_path: Path):
    # Shadow fix (xtrm-u54wt #2): the canonical .xtrm registry must win over a stale
    # repo-root / legacy .claude registry, so a migrated repo never gets shadowed.
    root_reg = tmp_path / "service-registry.json"
    root_reg.write_text("{}")
    legacy_reg = tmp_path / ".claude/skills/service-registry.json"
    legacy_reg.parent.mkdir(parents=True)
    legacy_reg.write_text("{}")
    pack_reg = tmp_path / ".xtrm/skills/user/packs/mercury/service-registry.json"
    pack_reg.parent.mkdir(parents=True)
    pack_reg.write_text("{}")
    assert get_registry_path(str(tmp_path)) == pack_reg


def test_umbrella_registry_wins_over_everything(tmp_path: Path):
    umbrella_reg = tmp_path / ".xtrm/skills/user/packs/mercury/service-skills/service-registry.json"
    umbrella_reg.parent.mkdir(parents=True)
    umbrella_reg.write_text("{}")
    flat_reg = tmp_path / ".xtrm/skills/user/packs/mercury/service-registry.json"
    flat_reg.write_text("{}")
    root_reg = tmp_path / "service-registry.json"
    root_reg.write_text("{}")
    assert get_registry_path(str(tmp_path)) == umbrella_reg


def test_root_used_only_when_no_xtrm_registry(tmp_path: Path):
    root_reg = tmp_path / "service-registry.json"
    root_reg.write_text("{}")
    assert get_registry_path(str(tmp_path)) == root_reg


def test_xtrm_pack_env_selects_umbrella_pack(tmp_path: Path, monkeypatch):
    # xtrm-5bnfk: with multiple packs present under the umbrella layout, $XTRM_PACK
    # must steer get_registry_path to that pack's umbrella registry (not just the
    # alphabetically-first one). Pre-fix, _select_pack_registry only matched the
    # flat <pack>/service-registry.json layout, so umbrella registries fell
    # through to sorted()[0] and silently picked the wrong pack.
    for pack in ("infra", "darth-feedor"):
        reg = tmp_path / f".xtrm/skills/user/packs/{pack}/service-skills/service-registry.json"
        reg.parent.mkdir(parents=True)
        reg.write_text("{}")
    monkeypatch.setenv("XTRM_PACK", "infra")
    chosen = get_registry_path(str(tmp_path))
    assert chosen == tmp_path / ".xtrm/skills/user/packs/infra/service-skills/service-registry.json"


def test_scope_find_registry_resolves_canonical_pack(tmp_path: Path, monkeypatch):
    # xtrm-5bnfk: scope.py previously had its own resolver that only knew
    # .claude/skills/service-registry.json — it never found the canonical
    # .xtrm/skills/user/packs/<pack>/service-skills/service-registry.json,
    # so on mercury-infra the specialist's pre-script always reported
    # 'No drift detected' even when drift existed. The fix delegates
    # scope.find_registry() to bootstrap.get_registry_path().
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import scope as scope_mod
    canonical = tmp_path / ".xtrm/skills/user/packs/infra/service-skills/service-registry.json"
    canonical.parent.mkdir(parents=True)
    canonical.write_text("{}")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    monkeypatch.delenv("XTRM_PACK", raising=False)
    monkeypatch.delenv("SERVICE_REGISTRY_PATH", raising=False)
    assert scope_mod.find_registry() == canonical


def test_scope_find_registry_returns_none_when_absent(tmp_path: Path, monkeypatch):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import scope as scope_mod
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    monkeypatch.delenv("XTRM_PACK", raising=False)
    monkeypatch.delenv("SERVICE_REGISTRY_PATH", raising=False)
    assert scope_mod.find_registry() is None


def test_scope_find_registry_honours_env_override(tmp_path: Path, monkeypatch):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import scope as scope_mod
    custom = tmp_path / "custom-registry.json"
    custom.write_text("{}")
    monkeypatch.setenv("SERVICE_REGISTRY_PATH", str(custom))
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    assert scope_mod.find_registry() == custom


def test_run_gitnexus_json_omits_json_flag_and_uses_repo(tmp_path: Path, monkeypatch):
    captured = {}

    class FakeProc:
        # gitnexus now runs via Popen(start_new_session=True) so a timeout can reap the
        # whole process group (xtrm-08i0b); the mock mirrors that surface.
        returncode = 0

        def __init__(self, cmd, **kwargs):
            captured["cmd"] = cmd
            captured["start_new_session"] = kwargs.get("start_new_session")

        def communicate(self, timeout=None):
            return ("No changes detected\n", "")

        def poll(self):
            return 0

    monkeypatch.setattr(bootstrap.subprocess, "Popen", FakeProc)
    monkeypatch.setattr(bootstrap, "get_project_root", lambda: str(tmp_path))
    # Isolate from the repo-name resolver: _gitnexus_repo_name now shells out via
    # subprocess.run (git --git-common-dir, xtrm-vvhfs), which would collide with the
    # FakeProc Popen stub. This test only asserts run_gitnexus_json's flag/-repo wiring.
    monkeypatch.setattr(bootstrap, "_gitnexus_repo_name", lambda project_root=None: "mock-repo")
    assert bootstrap.run_gitnexus_json(["detect_changes", "--scope", "unstaged"]) == {"output": "No changes detected"}
    assert "--json" not in captured["cmd"]
    assert "--repo" in captured["cmd"]
    assert captured["start_new_session"] is True
