"""Evidence report: JSON round-trips the manifest; Markdown names flagged claims + refs."""
import json

from verifier.evidence_report import render_json, render_markdown
from verifier.manifest import ClaimManifest, content_hash
from verifier.taxonomy import Claim, ClaimType, Comparison, Verdict


def _manifest() -> ClaimManifest:
    flagged = Claim(
        service_id="api-gateway",
        section_path="API Gateway > CRITICAL REQUIREMENTS",
        claim_text="The redaction placeholder is `[REDACTED]`.",
        claim_type=ClaimType.QUOTED_LITERAL,
        subject="redaction placeholder",
        objects=["[REDACTED]"],
        comparison=Comparison.UNEQUAL,
        source_refs=["source/config/redaction.py"],
        verdict=Verdict.CONFLICT,
        advisories=["source defines redaction placeholder as '***'"],
    )
    passing = Claim(
        service_id="api-gateway",
        section_path="API Gateway > Data Flows",
        claim_text="ok claim",
        claim_type=ClaimType.COMPOSE_RESOURCE,
        verdict=Verdict.PASS,
    )
    return ClaimManifest(
        service_id="api-gateway",
        candidate_hash=content_hash("cand"),
        current_hash=content_hash("curr"),
        claims=[flagged, passing],
    )


def test_render_json_round_trips_manifest():
    parsed = json.loads(render_json(_manifest()))
    assert parsed["service_id"] == "api-gateway"
    assert parsed["summary"]["CONFLICT"] == 1


def test_markdown_names_flagged_claim_and_source_refs():
    md = render_markdown(_manifest())
    assert "redaction placeholder" in md
    assert "source/config/redaction.py" in md
    assert "CONFLICT" in md


def test_markdown_summary_counts():
    md = render_markdown(_manifest())
    assert "Claims checked: **2**" in md
    assert "CONFLICT: **1**" in md
    assert "PASS: **1**" in md


def test_markdown_no_flagged_message_when_all_pass():
    manifest = ClaimManifest(service_id="svc", candidate_hash=content_hash("a"), current_hash=content_hash("b"), claims=[])
    md = render_markdown(manifest)
    assert "No claims flagged" in md
