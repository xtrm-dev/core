import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from drift_detector import scan_drift


def test_scan_missing_registry_prints_hint(tmp_path: Path, capsys):
    assert scan_drift(str(tmp_path)) == []
    err = capsys.readouterr().err
    assert "Registry not found." in err
    assert ".xtrm/skills/user/packs/*/service-registry.json" in err
