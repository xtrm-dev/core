from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from skill_migrator import migrate_skill_markdown


FULL_SKILL = """---
name: example
---

# Example Skill

## Service Overview

Overview body.

## Architecture

Architecture body.

## CRITICAL REQUIREMENTS

Requirements body.

## Data Flows

Data body.

## Database Interactions

DB body.

## Cross-Service Health Check

Health body.

## Common Operations

Ops body.

## Failure Modes

Failure body.

## Deploy & Runbook

Deploy body.

<!-- SEMANTIC_START -->
## Semantic Deep Dive (Human/Agent Refined)

keep me verbatim

<!-- SEMANTIC_END -->

## Scripts

Scripts body.

## References

Refs body.
"""


def test_missing_sections_added(tmp_path: Path):
    input_text = """# Example Skill

## Service Overview

Overview body.

## Data Flows

Data body.

<!-- SEMANTIC_START -->
## Semantic Deep Dive (Human/Agent Refined)

keep me verbatim

<!-- SEMANTIC_END -->

## References

Refs body.
"""
    migrated, changed = migrate_skill_markdown(input_text)
    assert changed is True
    assert "## Architecture" in migrated
    assert "## CRITICAL REQUIREMENTS" in migrated
    assert "## Database Interactions" in migrated
    assert "## Cross-Service Health Check" in migrated
    assert "## Common Operations" in migrated
    assert "## Failure Modes" in migrated
    assert "## Deploy & Runbook" in migrated
    assert "## Scripts" in migrated


def test_semantic_block_preserved_byte_identical():
    migrated, changed = migrate_skill_markdown(FULL_SKILL)
    assert changed is False
    assert migrated == FULL_SKILL
    semantic_block = FULL_SKILL.split("<!-- SEMANTIC_START -->", 1)[1].split("<!-- SEMANTIC_END -->", 1)[0]
    migrated_block = migrated.split("<!-- SEMANTIC_START -->", 1)[1].split("<!-- SEMANTIC_END -->", 1)[0]
    assert migrated_block == semantic_block


def test_idempotent_rerun_no_diff():
    once, changed_once = migrate_skill_markdown(FULL_SKILL.replace("## Cross-Service Health Check\n\nHealth body.\n\n", ""))
    twice, changed_twice = migrate_skill_markdown(once)
    assert changed_once is True
    assert changed_twice is False
    assert twice == once


def test_partial_existing_sections_keep_existing_text():
    input_text = """# Example Skill

## Service Overview

Overview body.

## Architecture

Architecture body.

## Data Flows

Data body.

## Scripts

Scripts body.

## References

Refs body.
"""
    migrated, changed = migrate_skill_markdown(input_text)
    assert changed is True
    assert migrated.count("## Data Flows") == 1
    assert migrated.count("## Scripts") == 1
    assert "Overview body." in migrated
    assert "Architecture body." in migrated
    assert "Data body." in migrated
    assert "Scripts body." in migrated
    assert "Refs body." in migrated
