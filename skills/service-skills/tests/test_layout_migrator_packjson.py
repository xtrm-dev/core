"""layout_migrator must sync PACK.json skills[] after migration (xtrm-x8b5g).

The active-view materializer validates a pack's PACK.json skills[] against the filesystem (a
skill = a direct-child dir of the pack containing a SKILL.md, identified by dir name). After
migration the moved per-service dirs live under service-skills/services/ (no longer direct
children) and the new service-skills umbrella IS a direct child — so a stale PACK.json lists
ghost services + omits the umbrella, tripping PACK_METADATA_MISMATCH which blocks the rebuild.
"""
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import layout_migrator as lm  # noqa: E402


def _flat_pack_with_packjson(root: Path, pack_name: str, services: list[str],
                             regular_skills: list[str]) -> Path:
    """Flat-layout pack with a PACK.json listing the OLD (pre-migration) skills:
    the flat service dirs + any regular (non-service) skill dirs."""
    pack = root / ".xtrm" / "skills" / "user" / "packs" / pack_name
    reg = {"version": "1.0", "services": {}}
    for sid in services:
        (pack / sid).mkdir(parents=True)
        (pack / sid / "SKILL.md").write_text(f"# {sid}\n", encoding="utf-8")
        reg["services"][sid] = {"name": sid, "territory": [f"src/{sid}/**"],
                                "skill_path": f".claude/skills/{sid}/SKILL.md", "last_sync": "never"}
    for sk in regular_skills:
        (pack / sk).mkdir(parents=True)
        (pack / sk / "SKILL.md").write_text(f"# {sk}\n", encoding="utf-8")
    (pack / "service-registry.json").write_text(json.dumps(reg, indent=2), encoding="utf-8")
    # Stale PACK.json: lists the flat services + regulars, no 'service-skills' umbrella.
    (pack / "PACK.json").write_text(json.dumps({
        "schemaVersion": "1", "name": pack_name, "version": "1.0.0",
        "description": "User-created skill pack",
        "skills": sorted(services + regular_skills),
    }, indent=2), encoding="utf-8")
    return pack


def _pack_skills(pack: Path) -> list[str]:
    return json.loads((pack / "PACK.json").read_text())["skills"]


class TestPackJsonSync(unittest.TestCase):
    def test_pack_json_synced_after_migration(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            pack = _flat_pack_with_packjson(
                root, "market-data",
                services=["auth-service", "db-expert"],
                regular_skills=["using-tdd-guard"])
            res = lm.migrate_pack(root, pack, "market-data")
            self.assertEqual(res["status"], "ok")
            # Ghost services dropped (now under service-skills/services/), umbrella added,
            # regular skill kept. Matches the materializer's direct-child-with-SKILL.md rule.
            self.assertEqual(_pack_skills(pack), ["service-skills", "using-tdd-guard"])
            self.assertIsNotNone(res["pack_json_note"])

    def test_idempotent_second_run_leaves_pack_json_untouched(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            pack = _flat_pack_with_packjson(
                root, "p", services=["svc-a"], regular_skills=[])
            lm.migrate_pack(root, pack, "p")
            self.assertEqual(_pack_skills(pack), ["service-skills"])
            res2 = lm.migrate_pack(root, pack, "p")
            self.assertIsNone(res2["pack_json_note"])  # already in sync
            self.assertEqual(_pack_skills(pack), ["service-skills"])

    def test_no_pack_json_is_noop(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            # Build a flat pack but remove the PACK.json the helper writes.
            pack = _flat_pack_with_packjson(root, "p", services=["svc-a"], regular_skills=[])
            (pack / "PACK.json").unlink()
            res = lm.migrate_pack(root, pack, "p")
            self.assertEqual(res["status"], "ok")
            self.assertIsNone(res["pack_json_note"])


if __name__ == "__main__":
    unittest.main()
