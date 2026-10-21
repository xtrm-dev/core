"""Claim extractor: every implemented type with a true-positive AND true-negative.

True-positive  = verifier reaches the correct affirmative verdict (PASS for a true
                 claim, or correctly CONTRADICTS a false one).
True-negative  = verifier does not raise a false alarm (a true claim is not flagged
                 CONFLICT; non-claim/unchanged/curatorial lines yield no claim).
"""
from verifier.claim_extractor import extract_claims
from verifier.taxonomy import ClaimType, Comparison, Verdict


def _extract(candidate: str, corpus, service: str = "svc"):
    changed = set(range(1, len(candidate.splitlines()) + 1))
    return extract_claims(candidate, changed, corpus, service)


def _of_type(claims, claim_type):
    return [c for c in claims if c.claim_type is claim_type]


# --------------------------------------------------------------------------- #
# quoted_literal
# --------------------------------------------------------------------------- #

def test_quoted_literal_true_positive_pass(make_corpus):
    corpus = make_corpus({"config/redaction.py": 'REDACTION_PLACEHOLDER = "***"\n'})
    claims = _extract("The redaction placeholder is `***`.", corpus)
    matched = _of_type(claims, ClaimType.QUOTED_LITERAL)
    assert matched and matched[0].verdict is Verdict.PASS
    assert matched[0].comparison is Comparison.EQUAL


def test_quoted_literal_true_negative_contradicted(make_corpus):
    corpus = make_corpus({"config/redaction.py": 'REDACTION_PLACEHOLDER = "***"\n'})
    claims = _extract("The redaction placeholder is `[REDACTED]`.", corpus)
    matched = _of_type(claims, ClaimType.QUOTED_LITERAL)
    assert matched and matched[0].verdict is Verdict.CONFLICT
    assert matched[0].comparison is Comparison.UNEQUAL
    assert matched[0].source_refs == ["config/redaction.py"]


def test_quoted_literal_unknown_when_subject_absent(make_corpus):
    corpus = make_corpus({"config/other.py": "UNRELATED = 1\n"})
    claims = _extract("The redaction placeholder is `***`.", corpus)
    matched = _of_type(claims, ClaimType.QUOTED_LITERAL)
    assert matched and matched[0].verdict is Verdict.UNKNOWN


# --------------------------------------------------------------------------- #
# set_claim
# --------------------------------------------------------------------------- #

_ENTRYPOINT = (
    "#!/bin/sh\n"
    'sed -i "s|__A__|${ALERTMANAGER_PORT}|g" f\n'
    'sed -i "s|__B__|${SLACK_API_URL}|g" f\n'
)


def test_set_claim_true_positive_pass(make_corpus):
    corpus = make_corpus({"entrypoint.sh": _ENTRYPOINT})
    claims = _extract(
        "The entrypoint uses exactly 2 sed variables: `ALERTMANAGER_PORT`, `SLACK_API_URL`.",
        corpus,
    )
    matched = _of_type(claims, ClaimType.SET_CLAIM)
    assert matched and matched[0].verdict is Verdict.PASS
    assert matched[0].observed_count == 2
    assert matched[0].comparison is Comparison.EQUAL


def test_set_claim_true_negative_wrong_count(make_corpus):
    corpus = make_corpus({"entrypoint.sh": _ENTRYPOINT})
    claims = _extract(
        "The entrypoint uses exactly 3 sed variables: `ALERTMANAGER_PORT`, `SLACK_API_URL`, `GHOST`.",
        corpus,
    )
    matched = _of_type(claims, ClaimType.SET_CLAIM)
    assert matched and matched[0].verdict is Verdict.CONFLICT


def test_set_claim_unresolved_without_resolver(make_corpus):
    corpus = make_corpus({"config/redaction.py": 'REDACTION_KEYS = {"a"}\n'})
    claims = _extract("The complete set of redaction keys is: `a`, `b`.", corpus)
    matched = _of_type(claims, ClaimType.SET_CLAIM)
    assert matched and matched[0].verdict is Verdict.UNKNOWN
    assert matched[0].comparison is Comparison.UNRESOLVED
    assert matched[0].completeness.value == "complete"


def test_set_claim_golden_alertmanager_pass(load_fixture):
    candidate, current, corpus = load_fixture("alertmanager")
    from verifier.diff_parser import parse_diff

    diff = parse_diff(candidate, current)
    claims = extract_claims(candidate, diff.changed_line_numbers, corpus, "alertmanager")
    matched = _of_type(claims, ClaimType.SET_CLAIM)
    assert matched and matched[0].verdict is Verdict.PASS
    assert matched[0].observed_count == 4
    assert matched[0].expected_count == 4


# --------------------------------------------------------------------------- #
# metric_label_set
# --------------------------------------------------------------------------- #

_METRIC = 'Counter("runner_jobs_total", "d", labelnames=("queue", "result"))\n'


def test_metric_label_set_true_positive_pass(make_corpus):
    corpus = make_corpus({"metrics.py": _METRIC})
    claims = _extract("The `runner_jobs_total` metric carries labels `queue` and `result`.", corpus)
    matched = _of_type(claims, ClaimType.METRIC_LABEL_SET)
    assert matched and matched[0].verdict is Verdict.PASS
    assert matched[0].comparison is Comparison.EQUAL


def test_metric_label_set_true_negative_unequal(make_corpus):
    corpus = make_corpus({"metrics.py": _METRIC})
    claims = _extract("The `runner_jobs_total` metric carries labels `queue` only.", corpus)
    matched = _of_type(claims, ClaimType.METRIC_LABEL_SET)
    assert matched and matched[0].verdict is Verdict.CONFLICT
    assert matched[0].comparison is Comparison.UNEQUAL


def test_metric_label_set_unknown_when_metric_absent(make_corpus):
    corpus = make_corpus({"metrics.py": _METRIC})
    claims = _extract("The `ghost_total` metric carries labels `queue`.", corpus)
    matched = _of_type(claims, ClaimType.METRIC_LABEL_SET)
    assert matched and matched[0].verdict is Verdict.UNKNOWN


# --------------------------------------------------------------------------- #
# environment_constant
# --------------------------------------------------------------------------- #

_COMPOSE = "services:\n  runner:\n    environment:\n      RUNNER_TOKEN: \"FAKE_TOKEN\"\n"


def test_environment_constant_true_positive_pass(make_corpus):
    corpus = make_corpus({"compose.yaml": _COMPOSE})
    claims = _extract("The `RUNNER_TOKEN` environment variable is set to `FAKE_TOKEN`.", corpus)
    matched = _of_type(claims, ClaimType.ENVIRONMENT_CONSTANT)
    assert matched and matched[0].verdict is Verdict.PASS


def test_environment_constant_true_negative_wrong_value(make_corpus):
    corpus = make_corpus({"compose.yaml": _COMPOSE})
    claims = _extract("The `RUNNER_TOKEN` environment variable is set to `WRONG_VALUE`.", corpus)
    matched = _of_type(claims, ClaimType.ENVIRONMENT_CONSTANT)
    assert matched and matched[0].verdict is Verdict.CONFLICT
    assert matched[0].comparison is Comparison.UNEQUAL


def test_environment_constant_undefined_var_conflicts(make_corpus):
    corpus = make_corpus({"compose.yaml": _COMPOSE})
    claims = _extract("The `GHOST_VAR` environment variable must be set.", corpus)
    matched = _of_type(claims, ClaimType.ENVIRONMENT_CONSTANT)
    assert matched and matched[0].verdict is Verdict.CONFLICT


# --------------------------------------------------------------------------- #
# compose_resource
# --------------------------------------------------------------------------- #

def test_compose_resource_true_positive_pass(make_corpus):
    corpus = make_corpus({"compose.yaml": _COMPOSE})
    claims = _extract("The `runner` service executes jobs.", corpus)
    matched = _of_type(claims, ClaimType.COMPOSE_RESOURCE)
    assert matched and matched[0].verdict is Verdict.PASS


def test_compose_resource_true_negative_missing_service(make_corpus):
    corpus = make_corpus({"compose.yaml": _COMPOSE})
    claims = _extract("The `ghost-service` service executes jobs.", corpus)
    matched = _of_type(claims, ClaimType.COMPOSE_RESOURCE)
    assert matched and matched[0].verdict is Verdict.CONFLICT


# --------------------------------------------------------------------------- #
# gating: only new/modified lines, never curatorial content
# --------------------------------------------------------------------------- #

def test_unchanged_line_is_not_extracted(make_corpus):
    corpus = make_corpus({"compose.yaml": _COMPOSE})
    candidate = "intro\nThe `runner` service executes jobs.\n"
    # Only line 1 is "changed"; the claim on line 2 must be skipped.
    claims = extract_claims(candidate, {1}, corpus, "svc")
    assert _of_type(claims, ClaimType.COMPOSE_RESOURCE) == []


def test_semantic_block_content_is_never_extracted(make_corpus):
    corpus = make_corpus({"compose.yaml": _COMPOSE})
    candidate = (
        "## Semantic Deep Dive (Human/Agent Refined)\n\n"
        "<!-- SEMANTIC_START -->\n"
        "The `ghost-service` service executes jobs.\n"
        "<!-- SEMANTIC_END -->\n"
    )
    changed = set(range(1, len(candidate.splitlines()) + 1))
    claims = extract_claims(candidate, changed, corpus, "svc")
    assert _of_type(claims, ClaimType.COMPOSE_RESOURCE) == []
