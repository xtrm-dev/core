"""End-to-end: golden fixtures, the api-gateway 3-error regression, CLI smoke,
manifest schema conformance, and stderr telemetry."""
import json
import subprocess
import sys
from pathlib import Path

from verifier import verify_candidate
from verifier.manifest import validate_manifest
from verifier.taxonomy import ClaimType, Comparison, Verdict

SCRIPTS_DIR = Path(__file__).resolve().parents[2]
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def _by_type(manifest, claim_type):
    return [c for c in manifest.claims if c.claim_type is claim_type]


# --------------------------------------------------------------------------- #
# golden fixtures via the in-process API
# --------------------------------------------------------------------------- #

def test_api_gateway_regression_flags_three_classes(load_fixture):
    candidate, current, corpus = load_fixture("api-gateway")
    manifest = verify_candidate(candidate, current, service_id="api-gateway", corpus=corpus, emit_telemetry=False)

    redaction_set = _by_type(manifest, ClaimType.SET_CLAIM)
    assert redaction_set, "invented redaction-key set must surface as a set_claim"
    assert redaction_set[0].completeness.value == "complete"
    assert redaction_set[0].comparison is Comparison.UNRESOLVED

    literal = _by_type(manifest, ClaimType.QUOTED_LITERAL)
    assert literal and literal[0].verdict is Verdict.CONFLICT
    assert literal[0].comparison is Comparison.UNEQUAL

    labels = _by_type(manifest, ClaimType.METRIC_LABEL_SET)
    assert labels and labels[0].verdict is Verdict.CONFLICT
    assert labels[0].comparison is Comparison.UNEQUAL

    assert manifest.verdict_counts()["CONFLICT"] == 2
    assert manifest.verdict_counts()["UNKNOWN"] == 1


def test_alertmanager_closure_marker_passes(load_fixture):
    candidate, current, corpus = load_fixture("alertmanager")
    manifest = verify_candidate(candidate, current, service_id="alertmanager", corpus=corpus, emit_telemetry=False)
    set_claims = _by_type(manifest, ClaimType.SET_CLAIM)
    assert set_claims and set_claims[0].verdict is Verdict.PASS
    assert set_claims[0].observed_count == 4
    assert set_claims[0].comparison is Comparison.EQUAL


def test_runners_all_claims_pass(load_fixture):
    candidate, current, corpus = load_fixture("runners")
    manifest = verify_candidate(candidate, current, service_id="runners", corpus=corpus, emit_telemetry=False)
    assert manifest.verdict_counts()["PASS"] == 3
    assert manifest.verdict_counts()["CONFLICT"] == 0
    assert _by_type(manifest, ClaimType.METRIC_LABEL_SET)[0].verdict is Verdict.PASS
    assert _by_type(manifest, ClaimType.COMPOSE_RESOURCE)[0].verdict is Verdict.PASS
    assert _by_type(manifest, ClaimType.ENVIRONMENT_CONSTANT)[0].verdict is Verdict.PASS


def test_manifest_schema_conforms_for_api_gateway(load_fixture):
    candidate, current, corpus = load_fixture("api-gateway")
    manifest = verify_candidate(candidate, current, service_id="api-gateway", corpus=corpus, emit_telemetry=False)
    assert validate_manifest(manifest.to_dict()) == []


def test_whitespace_only_diff_produces_no_claims(load_fixture):
    # Reformat current into candidate with whitespace-only churn -> no claims extracted.
    _candidate, current, corpus = load_fixture("runners")
    churned = current.replace("Runner metrics are exported by a sidecar.", "Runner  metrics  are  exported  by  a  sidecar.")
    manifest = verify_candidate(churned, current, service_id="runners", corpus=corpus, emit_telemetry=False)
    assert manifest.claims == []


# --------------------------------------------------------------------------- #
# CLI smoke (subprocess) on all three fixtures
# --------------------------------------------------------------------------- #

def _run_cli(service: str, output_format: str) -> subprocess.CompletedProcess:
    base = FIXTURES_DIR / service
    return subprocess.run(
        [
            sys.executable, "-m", "verifier",
            "--candidate", str(base / "candidate.md"),
            "--current", str(base / "current.md"),
            "--territory", "source/**",
            "--refs", "base=abc123,head=def456",
            "--output-format", output_format,
        ],
        cwd=str(SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_exits_zero_and_emits_telemetry_for_all_fixtures():
    for service in ("api-gateway", "alertmanager", "runners"):
        proc = _run_cli(service, "json")
        assert proc.returncode == 0, f"{service} exited non-zero: {proc.stderr}"
        assert "component" in proc.stderr and '"verifier"' in proc.stderr
        payload = json.loads(proc.stdout)
        assert validate_manifest(payload) == []
        # verified_at_ref resolves to head
        assert payload["verified_at_ref"] == "def456"


def test_cli_markdown_names_the_three_api_gateway_claims():
    proc = _run_cli("api-gateway", "markdown")
    assert proc.returncode == 0
    md = proc.stdout
    assert "quoted_literal" in md
    assert "set_claim" in md
    assert "metric_label_set" in md
    assert "source/config/redaction.py" in md
    assert "source/metrics.py" in md


def test_cli_telemetry_is_grep_able_by_component():
    proc = _run_cli("alertmanager", "json")
    telemetry_lines = [ln for ln in proc.stderr.splitlines() if '"component": "verifier"' in ln]
    assert telemetry_lines, "expected a component=verifier telemetry line on stderr"
    payload = json.loads(telemetry_lines[0])
    assert payload["event"] == "run"
    assert payload["claim_count"] >= 1
