"""
TDD tests for sre-triage SKILL.md correctness.

Each test maps to a tracked beads issue. Run with:
  pytest .xtrm/skills/default/sre-triage/tests/ -v
"""

import re
from pathlib import Path

SKILL_PATH = Path(__file__).parent.parent / "SKILL.md"


def _content() -> str:
    return SKILL_PATH.read_text()


def _frontmatter(content: str) -> str:
    """Extract YAML frontmatter between the first two --- markers."""
    if not content.startswith("---"):
        return ""
    end = content.index("---", 3)
    return content[3:end]


def _section(content: str, heading: str) -> str:
    """Extract content from a heading until the next same-level heading."""
    idx = content.find(heading)
    if idx == -1:
        return ""
    after = content[idx:]
    # Find next ### heading (same or higher level)
    next_heading = re.search(r"\n###? ", after[len(heading) :])
    if next_heading:
        return after[: len(heading) + next_heading.start()]
    return after


# ---------------------------------------------------------------------------
# infra-veb: Step 6 must reference the correct health_check.py path
# ---------------------------------------------------------------------------


def test_step6_correct_health_check_path():
    """Step 6 verify command must point to a project-owned scripts/health_check.py, not the skill scripts dir."""
    content = _content()
    step6 = _section(content, "### Step 6")
    assert (
        "infra/scripts/health_check.py" in step6
    ), "Step 6 should reference the project's <infra>/scripts/health_check.py fallback"
    assert (
        "sre-triage/scripts/health_check.py" not in step6
        and "checking-stack-health/scripts/health_check.py" not in step6
    ), "Step 6 references a non-existent health_check.py inside the skill scripts dir"


# ---------------------------------------------------------------------------
# infra-crv: SKILL_DIR must use $CLAUDE_PROJECT_DIR, not a hardcoded path
# ---------------------------------------------------------------------------


def test_skill_dir_uses_env_var():
    """SKILL_DIR in Step 2b must reference $CLAUDE_PROJECT_DIR, not a hardcoded host path."""
    content = _content()
    step2b = _section(content, "### Step 2b")
    assert (
        "$CLAUDE_PROJECT_DIR" in step2b
    ), "SKILL_DIR should be set via $CLAUDE_PROJECT_DIR for portability"
    assert (
        "SKILL_DIR=~/projects" not in step2b
    ), "SKILL_DIR must not be hardcoded to a ~/projects/... host path"


# ---------------------------------------------------------------------------
# Regression: TraefikHighLatency must map to the traefik service skill,
# not to whatever API service sits behind the proxy
# ---------------------------------------------------------------------------


def test_traefik_latency_maps_to_traefik_skill():
    """Alert→Service table: TraefikHighLatency must map to the traefik skill, not the backend API."""
    content = _content()
    # Find the table row for TraefikHighLatency and capture the Likely service/container column.
    match = re.search(r"\|\s*`TraefikHighLatency`\s*\|[^|]+\|([^|]+)\|", content)
    assert match, "TraefikHighLatency row not found in Alert→Service mapping table"
    mapping = match.group(1).strip()
    assert (
        "traefik" in mapping.lower()
    ), f"TraefikHighLatency should map to traefik skill, got: {mapping!r}"
    # The bug being prevented: routing latency at the proxy to a backend API skill
    # rather than to the proxy's own skill. The literal upstream-API name varies by
    # project; the rule is "must contain 'traefik'", which the positive assertion above covers.


# ---------------------------------------------------------------------------
# infra-ag8: allowed-tools must include Bash(docker *)
# ---------------------------------------------------------------------------


def test_allowed_tools_includes_docker():
    """Frontmatter allowed-tools must include Bash(docker *) for fallback commands."""
    content = _content()
    fm = _frontmatter(content)
    assert (
        "Bash(docker" in fm
    ), "allowed-tools must include Bash(docker *) — Step 2b fallback uses docker commands"


# ---------------------------------------------------------------------------
# infra-31l: Step 2b must instruct deriving --hours from the user's statement
# ---------------------------------------------------------------------------


def test_hours_derived_from_user_statement():
    """Step 2b must tell the agent to derive the --hours value from what the user said."""
    content = _content()
    step2b = _section(content, "### Step 2b")
    keywords = [
        "derive",
        "from the user",
        "user said",
        "user mention",
        "user's statement",
    ]
    assert any(kw in step2b.lower() for kw in keywords), (
        "Step 2b must instruct the agent to derive --hours from the user's statement, "
        "not always default to --hours 6"
    )


# ---------------------------------------------------------------------------
# infra-cdl: description must mention retroactive / past-alert investigation
# ---------------------------------------------------------------------------


def test_description_mentions_retroactive_investigation():
    """Frontmatter description must mention past alerts or retroactive investigation."""
    content = _content()
    fm = _frontmatter(content)
    desc_match = re.search(r"description:\s*>-\s*\n((?:  .*\n?)+)", fm)
    assert desc_match, "description field not found in frontmatter"
    desc = desc_match.group(1).lower()
    keywords = [
        "past alert",
        "retroactive",
        "hours ago",
        "telegram",
        "resolved alert",
        "historical",
    ]
    assert any(
        kw in desc for kw in keywords
    ), f"Description should mention retroactive/past-alert investigation capability. Got: {desc!r}"


# ---------------------------------------------------------------------------
# infra-2it: Step 2b must not use nested "Step 1" / "Step 2" labels
# ---------------------------------------------------------------------------


def test_no_nested_step_labels_in_step2b():
    """Step 2b must not use '**Step 1' / '**Step 2' — collides with outer numbered steps."""
    content = _content()
    step2b = _section(content, "### Step 2b")
    assert (
        "**Step 1" not in step2b
    ), "Step 2b must not use '**Step 1' internally — use 'Phase A' or bullet points instead"
    assert (
        "**Step 2" not in step2b
    ), "Step 2b must not use '**Step 2' internally — use 'Phase B' or bullet points instead"


# ---------------------------------------------------------------------------
# infra-dua: scripts: must not appear in YAML frontmatter
# ---------------------------------------------------------------------------


def test_no_scripts_key_in_frontmatter():
    """The scripts: key is non-standard and must not appear in YAML frontmatter."""
    content = _content()
    fm = _frontmatter(content)
    assert (
        "scripts:" not in fm
    ), "scripts: is not a recognized Claude skill frontmatter key — move it to the skill body"


# ---------------------------------------------------------------------------
# infra-01l: freshness probe must be cadence-aware, not a blanket >600s query
# ---------------------------------------------------------------------------


def test_freshness_probe_is_cadence_aware():
    """Step 1/6 freshness query must not flag daily/hourly feeds with a blanket 600s SLO."""
    content = _content()
    step1 = _section(content, "### Step 1 — Live Health Probe via mcpq")
    step6 = _section(content, "### Step 6")

    # Regression: the original blanket query lacked a feed_id filter and flagged
    # daily/hourly feeds. Forbid the pattern of `time() - <freshness_metric> > 600`
    # without a {feed_id=~...} narrow. The freshness metric name itself is
    # project-shaped (the placeholder example uses `example_project_freshness_*`).
    forbidden_re = re.compile(r"time\(\)\s*-\s*\w*freshness\w*\s*>\s*600\s*$", re.MULTILINE)
    assert not forbidden_re.search(step1), "Step 1 must not use a blanket freshness >600s query"
    assert not forbidden_re.search(step6), "Step 6 must not use a blanket freshness >600s query"

    combined = (step1 + step6).lower()
    assert (
        "cadence-aware" in combined
    ), "Freshness guidance should explicitly be cadence-aware"
    assert (
        "feed_id=~" in step1
    ), "Step 1 should narrow the 600s SLO to known fast/live feeds"
    assert (
        "daily" in combined and "hourly" in combined
    ), "Freshness guidance must say daily/hourly feeds are not degraded solely by >600s age"
