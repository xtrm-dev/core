"""Taxonomy stability: 13 types, 5 implemented, 8 deferred, partition is exact."""
from verifier.taxonomy import (
    DEFERRED_TYPES,
    IMPLEMENTED_TYPES,
    Claim,
    ClaimType,
    Comparison,
    Completeness,
    Verdict,
)


def test_taxonomy_has_thirteen_types():
    assert len(ClaimType) == 13


def test_implemented_types_are_the_five_scope_cut():
    assert {t.value for t in IMPLEMENTED_TYPES} == {
        "quoted_literal",
        "set_claim",
        "metric_label_set",
        "environment_constant",
        "compose_resource",
    }


def test_deferred_types_partition_the_remainder():
    assert IMPLEMENTED_TYPES.isdisjoint(DEFERRED_TYPES)
    assert IMPLEMENTED_TYPES | DEFERRED_TYPES == set(ClaimType)
    assert len(DEFERRED_TYPES) == 8


def test_claim_defaults_to_safe_advisory_values():
    claim = Claim(service_id="svc", section_path="A", claim_text="t", claim_type=ClaimType.SET_CLAIM)
    assert claim.verdict is Verdict.UNKNOWN
    assert claim.completeness is Completeness.UNKNOWN
    assert claim.comparison is Comparison.NOT_APPLICABLE
    assert claim.objects == []
    assert claim.source_refs == []
    assert claim.advisories == []


def test_verdict_and_completeness_are_string_valued():
    assert Verdict.PASS.value == "PASS"
    assert Completeness.COMPLETE.value == "complete"
