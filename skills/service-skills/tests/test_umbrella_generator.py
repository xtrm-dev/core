"""Tests for umbrella_generator.py — generated per-repo service umbrella."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import umbrella_generator as ug  # noqa: E402

REGISTRY = {
    "version": "1.0",
    "services": {
        "auth-service": {
            "name": "Auth Service",
            "container": "infra-auth",
            "territory": ["src/auth/**/*.py"],
            "skill_path": ".xtrm/skills/user/packs/market-data/service-skills/services/auth-service/SKILL.md",
            "description": "JWT auth",
            "last_sync": "2026-05-01T00:00:00Z",
            "last_sync_ref": "0d241bc1abcd",
        },
        "db-expert": {
            "name": "DB Expert",
            "territory": ["src/db/**/*.py"],
            "skill_path": ".xtrm/skills/user/packs/market-data/service-skills/services/db-expert/SKILL.md",
            "description": "schema",
            "last_sync": "never",
        },
    },
}


class TestRepoSkillName(unittest.TestCase):
    def test_kebab_and_suffix(self):
        self.assertEqual(ug.repo_skill_name("market-data"), "market-data-services")
        self.assertEqual(ug.repo_skill_name("Market_Data"), "market-data-services")
        self.assertEqual(ug.repo_skill_name("  My Repo!! "), "my-repo-services")

    def test_collision_safe_vs_machinery(self):
        # never equals the machinery skill name
        self.assertNotEqual(ug.repo_skill_name("service"), "service-skills")
        self.assertEqual(ug.repo_skill_name("service"), "service-services")


class TestGenerate(unittest.TestCase):
    def test_name_and_services_listed(self):
        out = ug.generate_umbrella(REGISTRY, "market-data")
        self.assertIn("name: market-data-services", out)
        self.assertIn("# market-data — Services", out)
        # both services + their resolved .xtrm skill_path appear
        self.assertIn("`auth-service`", out)
        self.assertIn("`db-expert`", out)
        self.assertIn(".xtrm/skills/user/packs/market-data/service-skills/services/auth-service/SKILL.md", out)
        # last_sync_ref short hash rendered
        self.assertIn("0d241bc1", out)
        # no hardcoded .claude/skills emission
        self.assertNotIn(".claude/skills", out)

    def test_required_sections_present(self):
        out = ug.generate_umbrella(REGISTRY, "market-data")
        for heading in ("## Services", "## Cross-Service Health", "## Navigation"):
            self.assertIn(heading, out)
        self.assertIn(ug.SEMANTIC_START, out)
        self.assertIn(ug.SEMANTIC_END, out)

    def test_empty_registry(self):
        out = ug.generate_umbrella({"services": {}}, "empty-repo")
        self.assertIn("name: empty-repo-services", out)
        self.assertIn("No services registered yet", out)

    def test_idempotent(self):
        once = ug.generate_umbrella(REGISTRY, "market-data")
        twice = ug.generate_umbrella(REGISTRY, "market-data", existing=once)
        self.assertEqual(once, twice)

    def test_semantic_block_preserved_across_regen(self):
        first = ug.generate_umbrella(REGISTRY, "market-data")
        # operator edits inside the protected block
        human = "## Cross-Service Operational Notes\n\nAuth must boot before db-expert; shared infra-pg on 5433."
        edited = first.replace(
            first[first.find(ug.SEMANTIC_START) + len(ug.SEMANTIC_START):first.find(ug.SEMANTIC_END)],
            f"\n{human}\n",
        )
        # regenerate with a CHANGED registry; human block must survive verbatim
        reg2 = {"version": "1.0", "services": dict(REGISTRY["services"])}
        reg2["services"]["new-svc"] = {"name": "New", "territory": [], "skill_path": "x/SKILL.md", "last_sync": "never"}
        regen = ug.generate_umbrella(reg2, "market-data", existing=edited)
        self.assertIn(human, regen)
        self.assertIn("`new-svc`", regen)  # table updated

    def test_write_umbrella_change_detection(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "service-skills" / "SKILL.md"
            self.assertTrue(ug.write_umbrella(p, REGISTRY, "market-data"))   # created
            self.assertFalse(ug.write_umbrella(p, REGISTRY, "market-data"))  # idempotent no-op


if __name__ == "__main__":
    unittest.main()
