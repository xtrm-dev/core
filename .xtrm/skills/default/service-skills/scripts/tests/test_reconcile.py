import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import reconcile


def test_build_prompt_includes_drift_evidence():
    prompt = reconcile.build_prompt(
        {
            "service_id": "alpha",
            "service_name": "Alpha",
            "file_path": "src/alpha.py",
            "symbols": ["alpha.run"],
            "processes": ["alpha-flow"],
            "tier": "high",
        },
        "# Alpha\nold",
        "def run(): pass",
    )

    assert "Return only the complete updated SKILL.md content" in prompt
    assert "alpha.run" in prompt
    assert "alpha-flow" in prompt
    assert "# Alpha\nold" in prompt
    assert "def run(): pass" in prompt


def test_parse_llm_response_extracts_content_and_tokens():
    result = reconcile.parse_llm_response(
        {"choices": [{"message": {"content": "# Updated\n"}}], "usage": {"total_tokens": 42}}
    )

    assert result.content == "# Updated\n"
    assert result.tokens == 42


def test_cost_cap_halts_before_request(tmp_path, monkeypatch):
    skill_path = tmp_path / "skills/alpha/SKILL.md"
    source_path = tmp_path / "src/alpha.py"
    skill_path.parent.mkdir(parents=True)
    source_path.parent.mkdir(parents=True)
    skill_path.write_text("# Alpha\n" + "x" * 100, encoding="utf-8")
    source_path.write_text("print('alpha')\n", encoding="utf-8")
    monkeypatch.setattr(reconcile, "get_project_root", lambda: str(tmp_path))
    monkeypatch.setattr(reconcile, "load_registry", lambda root: {"services": {"alpha": {"skill_path": "skills/alpha/SKILL.md"}}})
    monkeypatch.setattr(reconcile, "scan_drift", lambda *args, **kwargs: [{"service_id": "alpha", "file_path": "src/alpha.py"}])
    monkeypatch.setattr(reconcile, "call_nano_gpt", lambda prompt, api_key: pytest.fail("API should not be called"))

    result = reconcile.reconcile(reconcile.ReconcileOptions(False, None, "key", 1))

    assert result["status"] == "partial"
    assert result["reconciled_count"] == 0
    assert result["failed"][0]["error"] == "cost limit exceeded before request"


def test_missing_key_exits_2(monkeypatch, capsys):
    monkeypatch.delenv("NANO_GPT_API_KEY", raising=False)

    exit_code = reconcile.main(["--json"])

    assert exit_code == 2
    assert "NANO_GPT_API_KEY" in capsys.readouterr().err


def test_dry_run_does_not_write_or_bump(tmp_path, monkeypatch):
    skill_path = tmp_path / "skills/alpha/SKILL.md"
    source_path = tmp_path / "src/alpha.py"
    skill_path.parent.mkdir(parents=True)
    source_path.parent.mkdir(parents=True)
    skill_path.write_text("# Alpha\nold\n", encoding="utf-8")
    source_path.write_text("print('alpha')\n", encoding="utf-8")
    monkeypatch.setattr(reconcile, "get_project_root", lambda: str(tmp_path))
    monkeypatch.setattr(reconcile, "load_registry", lambda root: {"services": {"alpha": {"skill_path": "skills/alpha/SKILL.md"}}})
    monkeypatch.setattr(reconcile, "scan_drift", lambda *args, **kwargs: [{"service_id": "alpha", "file_path": "src/alpha.py"}])
    monkeypatch.setattr(reconcile, "current_head", lambda root: "new-sha")
    monkeypatch.setattr(reconcile, "call_nano_gpt", lambda prompt, api_key: reconcile.LlmResult("# Alpha\nnew\n", 10))
    monkeypatch.setattr(reconcile, "bump_last_sync_ref", lambda *args, **kwargs: pytest.fail("registry should not be bumped"))

    result = reconcile.reconcile(reconcile.ReconcileOptions(True, None, "key", None))

    assert result["status"] == "success"
    assert result["reconciled_count"] == 1
    assert skill_path.read_text(encoding="utf-8") == "# Alpha\nold\n"


def test_atomic_write_uses_os_replace(tmp_path, monkeypatch):
    target = tmp_path / "SKILL.md"
    calls = []
    real_replace = reconcile.os.replace

    def spy_replace(src, dst):
        calls.append((Path(src), Path(dst)))
        real_replace(src, dst)

    monkeypatch.setattr(reconcile.os, "replace", spy_replace)

    reconcile.atomic_write(target, "updated\n")

    assert target.read_text(encoding="utf-8") == "updated\n"
    assert calls[0][1] == target
    assert calls[0][0].parent == target.parent


def test_json_shape_snapshot(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("NANO_GPT_API_KEY", "key")
    monkeypatch.setattr(
        reconcile,
        "reconcile",
        lambda options: {
            "status": "success",
            "drift_count": 0,
            "reconciled_count": 0,
            "failed": [],
            "cost_tokens": 0,
            "last_sync_ref_old": None,
            "last_sync_ref_new": "abc123",
        },
    )

    exit_code = reconcile.main(["--json"])
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert list(payload) == [
        "cost_tokens",
        "drift_count",
        "failed",
        "last_sync_ref_new",
        "last_sync_ref_old",
        "reconciled_count",
        "status",
    ]
