"""Telemetry: one structured JSON line, grep-able by component=verifier, no claim text."""
import io
import json

from verifier.manifest import ClaimManifest, content_hash
from verifier.taxonomy import Claim, ClaimType, Verdict
from verifier.telemetry import emit_run, verdict_counts_by_type


def _manifest() -> ClaimManifest:
    claim = Claim(
        service_id="svc",
        section_path="A",
        claim_text="SECRET-LADEN PROSE that must never be logged",
        claim_type=ClaimType.SET_CLAIM,
        verdict=Verdict.CONFLICT,
    )
    return ClaimManifest(
        service_id="svc",
        candidate_hash=content_hash("cand"),
        current_hash=content_hash("curr"),
        claims=[claim],
    )


def test_emit_writes_single_json_line_with_component():
    stream = io.StringIO()
    line = emit_run(_manifest(), 1.234, stream=stream)
    assert stream.getvalue().strip() == line
    payload = json.loads(line)
    assert payload["component"] == "verifier"
    assert payload["event"] == "run"


def test_telemetry_carries_required_fields():
    payload = json.loads(emit_run(_manifest(), 5.0, stream=io.StringIO()))
    for key in ("timestamp", "component", "event", "candidate_hash", "current_hash", "service_id", "claim_count", "verdict_counts_by_type", "duration_ms"):
        assert key in payload
    assert payload["claim_count"] == 1


def test_telemetry_never_leaks_claim_text():
    line = emit_run(_manifest(), 1.0, stream=io.StringIO())
    assert "SECRET-LADEN PROSE" not in line


def test_verdict_counts_by_type_buckets():
    counts = verdict_counts_by_type(_manifest())
    assert counts["set_claim"]["CONFLICT"] == 1
