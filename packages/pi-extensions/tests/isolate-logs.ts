/**
 * CORE-2535: tests never write the production decision logs
 * (~/.xtrm/skill-suggest/log.jsonl, ~/.xtrm/substrate-suggest/log.jsonl).
 * Import first in any test that loads a suggest extension; both extensions
 * resolve their log dir per write, so this holds for every row.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["SKILL_SUGGEST_LOG_DIR"] ??= mkdtempSync(join(tmpdir(), "skill-suggest-log-"));
process.env["SUBSTRATE_SUGGEST_LOG_DIR"] ??= mkdtempSync(join(tmpdir(), "substrate-suggest-log-"));
