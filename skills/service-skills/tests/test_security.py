from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BOOTSTRAP_PATH = ROOT / "scripts" / "bootstrap.py"
SCAFFOLDER_PATH = ROOT / "scripts" / "scaffolder.py"


def load_module(path: Path, name: str):
    spec = spec_from_file_location(name, path)
    module = module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


bootstrap = load_module(BOOTSTRAP_PATH, "cs_bootstrap")
scaffolder = load_module(SCAFFOLDER_PATH, "cs_scaffolder")


def test_pack_path_rejects_traversal(tmp_path, monkeypatch):
    (tmp_path / ".xtrm" / "skills" / "user" / "packs").mkdir(parents=True)
    monkeypatch.setenv("XTRM_PACK", "../../etc/some-path")
    with pytest.raises(bootstrap.RootResolutionError):
        bootstrap.get_pack_path(str(tmp_path))


def test_validate_service_id_rejects_bad_values():
    for value in ["../foo", "/etc", "a/b"]:
        with pytest.raises(ValueError):
            scaffolder.validate_service_id(value)


def test_legacy_symlink_rejects_non_symlink_directory_outside_pack(tmp_path):
    pack_root = tmp_path / ".xtrm" / "skills" / "user" / "packs" / "pack-a"
    pack_root.mkdir(parents=True)
    target_dir = pack_root / "svc"
    target_dir.mkdir()
    legacy_dir = tmp_path / ".claude" / "skills" / "svc"
    legacy_dir.parent.mkdir(parents=True)
    legacy_dir.mkdir()

    with pytest.raises(ValueError):
        scaffolder.ensure_legacy_symlink(target_dir, legacy_dir, pack_root)
