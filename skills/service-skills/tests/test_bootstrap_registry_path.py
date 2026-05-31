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


def test_run_gitnexus_json_omits_json_flag_and_uses_repo(tmp_path: Path, monkeypatch):
    captured = {}

    class Result:
        returncode = 0
        stdout = "No changes detected\n"

    def fake_run(cmd, capture_output, text, timeout, check):
        captured["cmd"] = cmd
        return Result()

    monkeypatch.setattr(bootstrap.subprocess, "run", fake_run)
    monkeypatch.setattr(bootstrap, "get_project_root", lambda: str(tmp_path))
    assert bootstrap.run_gitnexus_json(["detect_changes", "--scope", "unstaged"]) == {"output": "No changes detected"}
    assert "--json" not in captured["cmd"]
    assert "--repo" in captured["cmd"]
