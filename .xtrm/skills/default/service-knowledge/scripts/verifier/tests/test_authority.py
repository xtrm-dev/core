"""Authority hierarchy ordering + path-based classification."""
from verifier.authority import Authority, authority_rank, meets_authority


def test_hierarchy_is_strictly_ordered():
    assert (
        Authority.EXECUTABLE_CODE
        > Authority.TESTS_FIXTURES
        > Authority.READ_ONLY_PROBE
        > Authority.SEMANTIC_BLOCK
        > Authority.VERIFIED_CLAIM
        > Authority.AUTO_GEN_UNVERIFIED
        > Authority.MEMORY_ITEM
    )


def test_executable_code_outranks_tests():
    assert authority_rank("src/redaction.py") == int(Authority.EXECUTABLE_CODE)
    assert authority_rank("src/redaction.py") > authority_rank("tests/test_redaction.py")


def test_test_paths_classify_as_tests_fixtures():
    assert authority_rank("tests/fixtures/compose.yaml") == int(Authority.TESTS_FIXTURES)


def test_probe_files_classify_as_read_only_probe():
    assert authority_rank("config/probe.json") == int(Authority.READ_ONLY_PROBE)


def test_meets_authority_threshold():
    assert meets_authority(["src/x.py"], int(Authority.EXECUTABLE_CODE))
    assert not meets_authority(["config/x.json"], int(Authority.EXECUTABLE_CODE))
    assert meets_authority([], 0)  # no requirement -> always met
