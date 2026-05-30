"""End-to-end regression for the service-skills v2 layout (xtrm-b86y5.6).

Drives the real scripts via subprocess in throwaway git repos and asserts the
integrated invariants of the new model:

  1. fresh scaffold -> new umbrella layout, generated SKILL.md is .claude-free,
     registry skill_path resolves under .xtrm
  2. umbrella generation -> lists the service, repo-qualified name
  3. flat -> umbrella layout migration -> files moved, registry relocated +
     rewritten, SEMANTIC preserved, idempotent
  4. drift scan -> runs without crashing and emits no cross-tool .claude/skills path

No network, no writes outside the tmp repos.
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _git_init(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)


def _run(script: str, *args: str, cwd: Path, pack: str | None = None):
    env = {**os.environ}
    if pack:
        env["XTRM_PACK"] = pack
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        cwd=str(cwd), env=env, capture_output=True, text=True,
    )


class TestE2ELayout(unittest.TestCase):
    def test_scaffold_lands_in_new_layout_claude_free(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            _git_init(root)
            (root / ".xtrm/skills/user/packs/p1/service-skills").mkdir(parents=True)
            (root / ".xtrm/skills/user/packs/p1/service-skills/service-registry.json").write_text(
                '{"version":"1.0","services":{}}', encoding="utf-8")
            (root / "docker-compose.yml").write_text(
                "services:\n  cache-svc:\n    image: redis:7\n", encoding="utf-8")
            r = _run("scaffolder.py", "docker-compose.yml", "cache-svc", cwd=root, pack="p1")
            self.assertIn("Phase 1 Complete", r.stdout, msg=r.stderr)
            gen = root / ".xtrm/skills/user/packs/p1/service-skills/services/cache-svc/SKILL.md"
            self.assertTrue(gen.exists(), "scaffold must land under service-skills/services/")
            self.assertNotIn(".claude/skills", gen.read_text(), "generated SKILL.md must be .claude-free")
            # registry skill_path resolves under .xtrm
            reg = json.loads((root / ".xtrm/skills/user/packs/p1/service-skills/service-registry.json").read_text())
            sp = reg["services"]["cache-svc"]["skill_path"]
            self.assertTrue(sp.startswith(".xtrm/"))
            self.assertNotIn(".claude/skills", sp)

    def test_umbrella_lists_service(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            _git_init(root)
            pk = root / ".xtrm/skills/user/packs/market-data/service-skills"
            pk.mkdir(parents=True)
            (pk / "service-registry.json").write_text(json.dumps({"version": "1.0", "services": {
                "auth-service": {"name": "Auth", "territory": ["src/auth/**"],
                                 "skill_path": ".xtrm/skills/user/packs/market-data/service-skills/services/auth-service/SKILL.md",
                                 "last_sync": "never"}}}), encoding="utf-8")
            r = _run("umbrella_generator.py", "market-data", cwd=root, pack="market-data")
            self.assertTrue(r.stdout.startswith("generated:"), msg=r.stderr)
            umb = (pk / "SKILL.md").read_text()
            self.assertIn("name: market-data-services", umb)
            self.assertIn("`auth-service`", umb)

    def test_flat_to_umbrella_migration_and_idempotence(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            _git_init(root)
            pk = root / ".xtrm/skills/user/packs/market-data"
            for sid in ("auth-service", "db-expert"):
                sd = pk / sid / "scripts"
                sd.mkdir(parents=True)
                (pk / sid / "SKILL.md").write_text(
                    f"# {sid}\n<!-- SEMANTIC_START -->\nhuman {sid} notes\n<!-- SEMANTIC_END -->\n", encoding="utf-8")
                (sd / "health_probe.py").write_text("# probe\n", encoding="utf-8")
            (pk / "service-registry.json").write_text(json.dumps({"version": "1.0", "services": {
                "auth-service": {"name": "Auth", "territory": ["src/auth/**"], "skill_path": ".claude/skills/auth-service/SKILL.md", "last_sync": "never"},
                "db-expert": {"name": "DB", "territory": ["src/db/**"], "skill_path": ".claude/skills/db-expert/SKILL.md", "last_sync": "never"},
            }}), encoding="utf-8")
            r = _run("layout_migrator.py", "market-data", cwd=root, pack="market-data")
            self.assertIn("migrated: auth-service", r.stdout, msg=r.stderr)
            # moved, flat gone, SEMANTIC preserved, registry relocated + rewritten
            moved = pk / "service-skills/services/auth-service/SKILL.md"
            self.assertTrue(moved.exists())
            self.assertFalse((pk / "auth-service").exists())
            self.assertIn("human auth-service notes", moved.read_text())
            self.assertFalse((pk / "service-registry.json").exists())
            new_reg = json.loads((pk / "service-skills/service-registry.json").read_text())
            for sid in ("auth-service", "db-expert"):
                self.assertTrue(new_reg["services"][sid]["skill_path"].startswith(".xtrm/"))
                self.assertNotIn(".claude/skills", new_reg["services"][sid]["skill_path"])
            self.assertIn("name: market-data-services", (pk / "service-skills/SKILL.md").read_text())
            # idempotent
            r2 = _run("layout_migrator.py", "market-data", cwd=root, pack="market-data")
            self.assertIn("already-migrated", r2.stdout)
            self.assertIn("umbrella: unchanged", r2.stdout)

    def test_drift_scan_runs_without_claude_emission(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            _git_init(root)
            pk = root / ".xtrm/skills/user/packs/p/service-skills"
            (pk / "services").mkdir(parents=True)
            (pk / "service-registry.json").write_text('{"version":"1.0","services":{}}', encoding="utf-8")
            r = _run("drift_detector.py", "scan", cwd=root, pack="p")
            self.assertEqual(r.returncode, 0, msg=r.stderr)
            # the scan output itself must not emit a cross-tool .claude/skills path
            # (the only allowed mention is the annotated 'legacy view' hint on stderr)
            for line in r.stdout.splitlines():
                self.assertNotIn(".claude/skills", line)


if __name__ == "__main__":
    unittest.main()
