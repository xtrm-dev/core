import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from bootstrap import get_registry_path


def test_pack_only_registry(tmp_path: Path):
    reg = tmp_path / ".xtrm/skills/user/packs/mercury/service-registry.json"
    reg.parent.mkdir(parents=True)
    reg.write_text("{}")
    assert get_registry_path(str(tmp_path)) == reg


def test_root_wins_over_pack(tmp_path: Path):
    root_reg = tmp_path / "service-registry.json"
    root_reg.write_text("{}")
    pack_reg = tmp_path / ".xtrm/skills/user/packs/mercury/service-registry.json"
    pack_reg.parent.mkdir(parents=True)
    pack_reg.write_text("{}")
    assert get_registry_path(str(tmp_path)) == root_reg
