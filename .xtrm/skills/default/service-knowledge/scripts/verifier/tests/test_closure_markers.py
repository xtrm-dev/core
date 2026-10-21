"""Closure-marker detection: aggressive default-to-unknown (research §2.4 / §7)."""
from verifier.closure_markers import detect_closure
from verifier.taxonomy import Completeness


def test_exactly_n_digit():
    info = detect_closure("The entrypoint uses exactly 4 sed variables.")
    assert info.completeness is Completeness.COMPLETE
    assert info.expected_count == 4


def test_the_n_word_are():
    info = detect_closure("The three keys are listed below.")
    assert info.completeness is Completeness.COMPLETE
    assert info.expected_count == 3


def test_complete_list_keyword():
    info = detect_closure("This is the complete list of redaction keys.")
    assert info.completeness is Completeness.COMPLETE
    assert info.expected_count is None


def test_all_of_the_keyword():
    info = detect_closure("All of the environment variables are templated.")
    assert info.completeness is Completeness.COMPLETE


def test_no_marker_defaults_to_unknown():
    # True-negative: ordinary prose must NOT be read as a closed set.
    info = detect_closure("The entrypoint templates its config with sed at boot.")
    assert info.completeness is Completeness.UNKNOWN
    assert info.expected_count is None
    assert info.marker == ""


def test_bare_number_without_closure_is_unknown():
    # "4 sed variables" without 'exactly'/'the ... are' is not a closure assertion.
    info = detect_closure("There are 4 sed variables used during boot.")
    assert info.completeness is Completeness.UNKNOWN
