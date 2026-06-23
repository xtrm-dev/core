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


def test_max_files_truncation_marks_partial_and_lists_deferred_xtrm_vlxug(tmp_path, monkeypatch):
    """Regression: --max-files < drift_count must mark status=partial AND list
    the un-processed entries in failed[], so bump_last_sync_ref is skipped and
    the deferred drift stays visible to the next scan_drift (xtrm-vlxug)."""
    skill_path = tmp_path / "skills/alpha/SKILL.md"
    source_path = tmp_path / "src/alpha.py"
    skill_path.parent.mkdir(parents=True)
    source_path.parent.mkdir(parents=True)
    skill_path.write_text("# Alpha\nold\n", encoding="utf-8")
    source_path.write_text("print('alpha')\n", encoding="utf-8")

    drifts = [
        {"service_id": "alpha", "file_path": "src/alpha.py", "skill_path": "skills/alpha/SKILL.md"},
        {"service_id": "beta", "file_path": "src/beta.py", "skill_path": "skills/beta/SKILL.md"},
        {"service_id": "gamma", "file_path": "src/gamma.py", "skill_path": "skills/gamma/SKILL.md"},
    ]
    monkeypatch.setattr(reconcile, "get_project_root", lambda: str(tmp_path))
    monkeypatch.setattr(reconcile, "load_registry", lambda root: {"services": {d["service_id"]: {"skill_path": d["skill_path"]} for d in drifts}})
    monkeypatch.setattr(reconcile, "scan_drift", lambda *args, **kwargs: drifts)
    monkeypatch.setattr(reconcile, "current_head", lambda root: "new-sha")
    monkeypatch.setattr(reconcile, "call_nano_gpt", lambda prompt, api_key: reconcile.LlmResult("# Updated\n", 10))
    monkeypatch.setattr(reconcile, "bump_last_sync_ref", lambda *a, **kw: pytest.fail("bump_last_sync_ref MUST NOT be called when --max-files truncates the drift set"))

    result = reconcile.reconcile(reconcile.ReconcileOptions(False, 1, "key", None))

    assert result["status"] == "partial"
    assert result["reconciled_count"] == 1
    # The 2 truncated services must appear in failed[] with a deferred marker.
    deferred = [f for f in result["failed"] if "deferred" in f.get("error", "")]
    assert len(deferred) == 2
    deferred_paths = sorted(f["file_path"] for f in deferred)
    assert deferred_paths == ["src/beta.py", "src/gamma.py"]


def test_bump_last_sync_ref_also_bumps_timestamp_xtrm_qxu4y(tmp_path, monkeypatch):
    """Regression: bump_last_sync_ref MUST bump both last_sync_ref AND last_sync.

    Without the timestamp bump, scan_drift's mtime comparison kept tripping on
    just-merged files (xtrm-qxu4y).
    """
    captured = {}

    def fake_load(_root):
        return {
            "services": {
                "alpha": {"last_sync": "2026-06-22T00:00:00Z", "last_sync_ref": "old-sha"},
                "beta": {"last_sync": "2026-06-22T00:00:00Z", "last_sync_ref": "old-sha"},
            }
        }

    def fake_save(registry, _root):
        captured["registry"] = registry

    monkeypatch.setattr(reconcile, "load_registry", fake_load)
    monkeypatch.setattr(reconcile, "save_registry", fake_save)
    monkeypatch.setattr(reconcile, "update_yaml_registry", lambda *a, **kw: None)

    old_ref = reconcile.bump_last_sync_ref(tmp_path, "new-sha", dry_run=False)

    assert old_ref == "old-sha"
    for service in captured["registry"]["services"].values():
        assert service["last_sync_ref"] == "new-sha"
        # New timestamp must be different from the stored old one (i.e. bumped).
        assert service["last_sync"] != "2026-06-22T00:00:00Z"
        assert service["last_sync"].endswith("Z")


def test_escaped_skill_path_fails_without_write(tmp_path, monkeypatch):
    source_path = tmp_path / "src/alpha.py"
    escaped_path = tmp_path.parent / "escape.md"
    source_path.parent.mkdir(parents=True)
    source_path.write_text("print('alpha')\n", encoding="utf-8")
    escaped_path.write_text("outside\n", encoding="utf-8")
    monkeypatch.setattr(reconcile, "get_project_root", lambda: str(tmp_path))
    monkeypatch.setattr(reconcile, "load_registry", lambda root: {"services": {"alpha": {"skill_path": "../escape.md"}}})
    monkeypatch.setattr(reconcile, "scan_drift", lambda *args, **kwargs: [{"service_id": "alpha", "file_path": "src/alpha.py"}])
    monkeypatch.setattr(reconcile, "call_nano_gpt", lambda prompt, api_key: pytest.fail("API should not be called"))

    result = reconcile.reconcile(reconcile.ReconcileOptions(False, None, "key", None))

    assert result["status"] == "partial"
    assert result["reconciled_count"] == 0
    assert "skill_path escapes project root" in result["failed"][0]["error"]
    assert escaped_path.read_text(encoding="utf-8") == "outside\n"


def test_invalid_nano_gpt_url_fails_at_startup(monkeypatch, capsys):
    monkeypatch.setenv("NANO_GPT_API_KEY", "key")
    monkeypatch.setenv("NANO_GPT_API_URL", "http://evil.com/x")
    monkeypatch.setattr(reconcile, "reconcile", lambda options: pytest.fail("reconcile should not run"))

    exit_code = reconcile.main(["--json"])
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == 1
    assert payload["status"] == "failed"
    assert "NANO_GPT_API_URL must use https" in payload["failed"][0]["error"]


def test_nano_gpt_url_rejects_secret_query_params():
    with pytest.raises(ValueError, match="secret query"):
        reconcile.validate_nano_gpt_url("https://nano-gpt.com/api?api_key=secret")


def test_redact_exception_masks_bearer_and_api_key():
    error = reconcile.redact_exception(RuntimeError("failed Bearer secret-token api-secret"), "api-secret")

    assert "secret-token" not in error
    assert "api-secret" not in error
    assert "Bearer [REDACTED]" in error
