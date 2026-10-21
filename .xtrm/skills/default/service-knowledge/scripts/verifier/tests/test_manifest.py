"""Manifest: stable claim IDs, content hashing, jsonschema conformance."""
from verifier.manifest import (
    SCHEMA_VERSION,
    ClaimManifest,
    claim_id,
    content_hash,
    validate_manifest,
)
from verifier.taxonomy import Claim, ClaimType, Verdict


def _claim(**overrides) -> Claim:
    base = dict(service_id="svc", section_path="A > B", claim_text="t", claim_type=ClaimType.SET_CLAIM)
    base.update(overrides)
    return Claim(**base)


def test_claim_id_is_stable_across_rebuilds():
    a = _claim(subject="sed variables", objects=["x", "y"])
    b = _claim(subject="sed variables", objects=["x", "y"])
    assert claim_id(a) == claim_id(b)


def test_claim_id_normalizes_object_order_and_whitespace():
    a = _claim(subject="sed  variables", objects=["y", "x"])
    b = _claim(subject="sed variables", objects=["x", "y"])
    assert claim_id(a) == claim_id(b)


def test_claim_id_differs_for_different_subjects():
    assert claim_id(_claim(subject="a")) != claim_id(_claim(subject="b"))


def test_content_hash_is_64_hex_and_deterministic():
    h = content_hash("hello")
    assert len(h) == 64 and all(c in "0123456789abcdef" for c in h)
    assert content_hash("hello") == h
    assert content_hash("hello!") != h


def test_manifest_validates_against_shipped_schema():
    claim = _claim(verdict=Verdict.PASS)
    manifest = ClaimManifest(
        service_id="svc",
        candidate_hash=content_hash("cand"),
        current_hash=content_hash("curr"),
        claims=[claim],
    )
    errors = validate_manifest(manifest.to_dict())
    assert errors == []


def test_schema_version_is_locked_at_one():
    assert SCHEMA_VERSION == 1
    claim = _claim()
    manifest = ClaimManifest(service_id="svc", candidate_hash=content_hash("a"), current_hash=content_hash("b"), claims=[claim])
    assert manifest.to_dict()["schema_version"] == 1
    assert manifest.to_dict()["claims"][0]["schema_version"] == 1


def test_invalid_manifest_is_rejected():
    bad = {"schema_version": 2, "verifier_id": "x"}  # wrong version + missing fields
    errors = validate_manifest(bad)
    assert errors  # non-empty
