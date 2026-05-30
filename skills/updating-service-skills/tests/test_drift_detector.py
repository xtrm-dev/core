import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import drift_detector


def _write_registry(root: Path, data: dict) -> None:
    path = root / "service-registry.json"
    path.write_text(json.dumps(data), encoding="utf-8")


def test_scan_committed_change_uses_gitnexus_and_sets_tier_source(tmp_path: Path, monkeypatch):
    _write_registry(
        tmp_path,
        {
            "version": "1.0.0",
            "services": {
                "alpha": {
                    "name": "Alpha",
                    "territory": ["skills/alpha/**/*"],
                    "skill_path": "skills/alpha/SKILL.md",
                    "last_sync": "2024-01-01T00:00:00Z",
                    "last_sync_ref": "base-sha",
                }
            },
        },
    )
    file_path = tmp_path / "skills/alpha/README.md"
    file_path.parent.mkdir(parents=True)
    file_path.write_text("alpha drift", encoding="utf-8")
    file_path.touch()
    monkeypatch.setattr(drift_detector, "is_gitnexus_available", lambda timeout=2.0: (True, "ok"))
    monkeypatch.setattr(drift_detector, "run_gitnexus_json", lambda args, timeout=2.0: {"output": f"changed: {file_path.relative_to(tmp_path)}"})
    monkeypatch.setattr(drift_detector, "_git_diff_files", lambda project_root, base_ref: [str(file_path.relative_to(tmp_path))])
    result = drift_detector.scan_drift(str(tmp_path), use_gitnexus=True)
    assert result[0]["gitnexus_status"] == "ok"
    assert result[0]["tier_source"] == "gitnexus"
    assert result[0]["tier"] in {"medium", "high"}


def test_scan_missing_ref_uses_mtime_fallback(tmp_path: Path, monkeypatch):
    _write_registry(
        tmp_path,
        {
            "version": "1.0.0",
            "services": {
                "alpha": {
                    "name": "Alpha",
                    "territory": ["skills/alpha/**/*"],
                    "skill_path": "skills/alpha/SKILL.md",
                    "last_sync": "2024-01-01T00:00:00Z",
                }
            },
        },
    )
    file_path = tmp_path / "skills/alpha/README.md"
    file_path.parent.mkdir(parents=True)
    file_path.write_text("alpha drift", encoding="utf-8")
    file_path.touch()
    monkeypatch.setattr(drift_detector, "is_gitnexus_available", lambda timeout=2.0: (False, "no_ref"))
    result = drift_detector.scan_drift(str(tmp_path), use_gitnexus=True)
    assert result[0]["gitnexus_status"] == "no_ref"
    assert result[0]["tier_source"] == "mtime"
    assert result[0]["tier"] == "unknown"


def test_scan_cli_error_labels_fallback(tmp_path: Path, monkeypatch):
    _write_registry(
        tmp_path,
        {
            "version": "1.0.0",
            "services": {
                "alpha": {
                    "name": "Alpha",
                    "territory": ["skills/alpha/**/*"],
                    "skill_path": "skills/alpha/SKILL.md",
                    "last_sync": "2024-01-01T00:00:00Z",
                    "last_sync_ref": "base-sha",
                }
            },
        },
    )
    file_path = tmp_path / "skills/alpha/README.md"
    file_path.parent.mkdir(parents=True)
    file_path.write_text("alpha drift", encoding="utf-8")
    file_path.touch()
    monkeypatch.setattr(drift_detector, "is_gitnexus_available", lambda timeout=2.0: (True, "ok"))
    monkeypatch.setattr(drift_detector, "run_gitnexus_json", lambda args, timeout=2.0: None)
    result = drift_detector.scan_drift(str(tmp_path), use_gitnexus=True)
    assert result[0]["gitnexus_status"] == "cli_error"
    assert result[0]["tier_source"] == "mtime"
    assert result[0]["tier"] == "unknown"
