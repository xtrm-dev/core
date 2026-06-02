"""layout_migrator must rewrite legacy in-body .claude/skills/<alias> refs (xtrm-8ike5).

The migrator MOVES each service's SKILL.md verbatim, so self-refs (by service-id OR by the
registry 'container' name) and umbrella cross-refs kept pointing at the dead flat path
.claude/skills/<name>/scripts/... . Incident (mercury-market-data): 27 stale refs across 8
skills, all fixed by hand. These tests pin the automatic rewrite + the unmapped-ref warning.
"""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import layout_migrator as lm  # noqa: E402


def _flat_pack(root: Path, pack_name: str, services: dict[str, dict]) -> Path:
    """services: {sid: {"body": str, "container": str|None}} -> flat-layout pack on disk."""
    pack = root / ".xtrm" / "skills" / "user" / "packs" / pack_name
    reg: dict = {"version": "1.0", "services": {}}
    for sid, spec in services.items():
        d = pack / sid
        (d / "scripts").mkdir(parents=True)
        (d / "SKILL.md").write_text(spec["body"], encoding="utf-8")
        (d / "scripts" / "health_probe.py").write_text("# probe\n", encoding="utf-8")
        entry = {"name": sid, "territory": [f"src/{sid}/**"],
                 "skill_path": f".claude/skills/{sid}/SKILL.md", "last_sync": "never"}
        if spec.get("container"):
            entry["container"] = spec["container"]
        reg["services"][sid] = entry
    (pack / "service-registry.json").write_text(json.dumps(reg, indent=2), encoding="utf-8")
    return pack


class TestRewriteClaudeRefs(unittest.TestCase):
    def test_rewrites_self_container_and_cross_refs(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            base = ".xtrm/skills/user/packs/market-data/service-skills/services"
            pack = _flat_pack(root, "market-data", {
                "ingesting-ohlcv": {
                    "container": "mmd-data-feed",
                    "body": (
                        "# feed\n"
                        "Run: .claude/skills/ingesting-ohlcv/scripts/health_probe.py\n"  # self by id
                        "make -C .claude/skills/mmd-data-feed test\n"                     # self by container
                        "See .claude/skills/serving-market-api/SKILL.md\n"               # cross by id
                    ),
                },
                "serving-market-api": {"container": "mmd-api", "body": "# api\n"},
            })
            res = lm.migrate_pack(root, pack, "market-data")
            self.assertEqual(res["status"], "ok")
            self.assertEqual(res["refs_rewritten"], 3)
            self.assertEqual(res["stale_refs"], [])

            moved = (pack / "service-skills/services/ingesting-ohlcv/SKILL.md").read_text()
            self.assertNotIn(".claude/skills", moved)
            self.assertIn(f"{base}/ingesting-ohlcv/scripts/health_probe.py", moved)        # self by id
            self.assertIn(f"make -C {base}/ingesting-ohlcv test", moved)                   # container -> id dir
            self.assertIn(f"{base}/serving-market-api/SKILL.md", moved)                    # cross-ref

    def test_idempotent_second_run_rewrites_nothing(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            pack = _flat_pack(root, "p", {
                "svc-a": {"body": "x .claude/skills/svc-a/scripts/probe.py\n"},
            })
            r1 = lm.migrate_pack(root, pack, "p")
            self.assertEqual(r1["refs_rewritten"], 1)
            r2 = lm.migrate_pack(root, pack, "p")
            self.assertEqual(r2["refs_rewritten"], 0)
            self.assertNotIn(".claude/skills", (pack / "service-skills/services/svc-a/SKILL.md").read_text())

    def test_unmapped_ref_left_intact_and_reported(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            pack = _flat_pack(root, "p", {
                "svc-a": {"body": "look .claude/skills/ghost-service/scripts/x.py\n"},
            })
            res = lm.migrate_pack(root, pack, "p")
            moved = (pack / "service-skills/services/svc-a/SKILL.md").read_text()
            # Unknown segment is preserved (never silently corrupted) and surfaced for review.
            self.assertIn(".claude/skills/ghost-service/scripts/x.py", moved)
            self.assertIn("ghost-service", res["stale_refs"])
            self.assertEqual(res["refs_rewritten"], 0)


if __name__ == "__main__":
    unittest.main()
