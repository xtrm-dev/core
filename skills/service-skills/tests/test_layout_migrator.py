"""Tests for layout_migrator.py — flat -> umbrella layout migration."""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import layout_migrator as lm  # noqa: E402


def _flat_pack(root: Path, pack_name: str, services: dict[str, str]) -> Path:
    """Build a flat-layout pack: packs/<pack>/<svc>/SKILL.md + pack-root registry."""
    pack = root / ".xtrm" / "skills" / "user" / "packs" / pack_name
    reg = {"version": "1.0", "services": {}}
    for sid, body in services.items():
        d = pack / sid
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(body, encoding="utf-8")
        (d / "scripts").mkdir()
        (d / "scripts" / "health_probe.py").write_text("# probe\n", encoding="utf-8")
        reg["services"][sid] = {
            "name": sid,
            "territory": [f"src/{sid}/**"],
            "skill_path": f".claude/skills/{sid}/SKILL.md",  # old broken path
            "last_sync": "never",
        }
    (pack / "service-registry.json").write_text(json.dumps(reg, indent=2), encoding="utf-8")
    return pack


class TestMigratePack(unittest.TestCase):
    def test_flat_to_umbrella_full(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            pack = _flat_pack(root, "market-data", {
                "auth-service": "# Auth\n<!-- SEMANTIC_START -->\nhuman notes\n<!-- SEMANTIC_END -->\n",
                "db-expert": "# DB\n",
            })
            res = lm.migrate_pack(root, pack, "market-data")
            self.assertEqual(res["status"], "ok")
            # services moved under umbrella/services
            for sid in ("auth-service", "db-expert"):
                self.assertTrue((pack / "service-skills" / "services" / sid / "SKILL.md").exists())
                self.assertFalse((pack / sid).exists())   # flat dir gone
                self.assertEqual(res["services"][sid], "migrated")
            # scripts moved verbatim
            self.assertTrue((pack / "service-skills" / "services" / "auth-service" / "scripts" / "health_probe.py").exists())
            # per-service SEMANTIC content preserved (moved verbatim, not regenerated)
            moved = (pack / "service-skills" / "services" / "auth-service" / "SKILL.md").read_text()
            self.assertIn("human notes", moved)
            # registry relocated + skill_path rewritten to .xtrm new location
            self.assertFalse((pack / "service-registry.json").exists())
            new_reg = json.loads((pack / "service-skills" / "service-registry.json").read_text())
            sp = new_reg["services"]["auth-service"]["skill_path"]
            self.assertEqual(sp, ".xtrm/skills/user/packs/market-data/service-skills/services/auth-service/SKILL.md")
            self.assertNotIn(".claude/skills", sp)
            # umbrella generated
            umb = (pack / "service-skills" / "SKILL.md").read_text()
            self.assertIn("name: market-data-services", umb)
            self.assertIn("`auth-service`", umb)

    def test_idempotent(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            pack = _flat_pack(root, "p", {"svc-a": "# A\n"})
            lm.migrate_pack(root, pack, "p")
            res2 = lm.migrate_pack(root, pack, "p")
            self.assertEqual(res2["services"]["svc-a"], "already-migrated")
            self.assertFalse(res2["umbrella_written"])  # no change second time

    def test_refuses_divergent_target(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            pack = _flat_pack(root, "p", {"svc-a": "# flat version\n"})
            # pre-create a divergent migrated target
            tgt = pack / "service-skills" / "services" / "svc-a"
            tgt.mkdir(parents=True)
            (tgt / "SKILL.md").write_text("# DIFFERENT migrated version\n", encoding="utf-8")
            with self.assertRaises(lm.MigrationRefused):
                lm.migrate_pack(root, pack, "p")
            # flat source untouched (no data loss)
            self.assertTrue((pack / "svc-a" / "SKILL.md").exists())

    def test_dedupes_identical_target(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            body = "# same\n"
            pack = _flat_pack(root, "p", {"svc-a": body})
            tgt = pack / "service-skills" / "services" / "svc-a"
            tgt.mkdir(parents=True)
            (tgt / "SKILL.md").write_text(body, encoding="utf-8")
            res = lm.migrate_pack(root, pack, "p")
            self.assertEqual(res["services"]["svc-a"], "deduped")
            self.assertFalse((pack / "svc-a").exists())  # identical flat copy removed


if __name__ == "__main__":
    unittest.main()
