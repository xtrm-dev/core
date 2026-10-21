"""Shared pytest fixtures for the verifier test suite."""
import sys
from pathlib import Path

import pytest

# verifier is a package under scripts/; put scripts/ on the path (sibling-test idiom).
SCRIPTS_DIR = Path(__file__).resolve().parents[2]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

from verifier import SourceCorpus  # noqa: E402


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture
def load_fixture():
    """Return (candidate_text, current_text, corpus) for a named golden fixture."""

    def _load(service: str) -> tuple[str, str, SourceCorpus]:
        base = FIXTURES_DIR / service
        candidate = (base / "candidate.md").read_text(encoding="utf-8")
        current = (base / "current.md").read_text(encoding="utf-8")
        corpus = SourceCorpus.from_globs(base, ["source/**"])
        return candidate, current, corpus

    return _load


@pytest.fixture
def make_corpus(tmp_path: Path):
    """Build a SourceCorpus from a {rel_path: text} mapping written under tmp_path."""

    def _make(files: dict[str, str]) -> SourceCorpus:
        for rel, text in files.items():
            path = tmp_path / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        return SourceCorpus.from_globs(tmp_path, ["**/*"])

    return _make
