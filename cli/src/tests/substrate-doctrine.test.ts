import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Anti-regression (ADR section 49): active current-state sources fail CI when
// they carry normative Beads content. Exceptions are explicit per-file
// allowlist entries — never broad grep exclusions. Historical documents,
// archived records, and out-of-scope runtime surfaces (e.g. worktree-session
// bd integration, spec tooling) are not scanned; they are not migrated here.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const START = '<!-- contract:start -->';
const END = '<!-- contract:end -->';

// Whole-file scan: migrated implementation, config, data, and their tests.
const WHOLE_FILES = [
  '.xtrm/config/hooks.json',
  '.xtrm/registry.json',
  'cli/src/core/machine-bootstrap.ts',
  'cli/src/commands/init.ts',
  'cli/src/core/init-verification.ts',
  'cli/src/core/dependency-maintenance.ts',
  'cli/src/commands/doctor.ts',
  'cli/src/core/settings-audit.ts',
  'cli/src/commands/install.ts',
  'cli/src/commands/update.ts',
  'cli/src/core/substrate.ts',
  'cli/src/core/substrate-migration.ts',
  'cli/src/core/claude-runtime-sync.ts',
  'cli/src/core/pi-runtime-hooks.ts',
  'cli/src/tests/agent-contract-parity.test.ts',
  'cli/src/tests/update.test.ts',
  'cli/src/tests/global-hooks-canonical.test.ts',
];

// Managed-block scan only: root guides keep operational Beads docs outside
// the block (this repo still runs on bd; no sb binary ships yet) while the
// managed contract itself must be Substrate-native (ADR section 48).
const MANAGED_BLOCK_FILES = [
  '.xtrm/config/instructions/agent-contract.md',
  '.xtrm/config/instructions/agents-top.md',
  '.xtrm/config/instructions/claude-top.md',
  'AGENTS.md',
  'CLAUDE.md',
];

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Beads owns durable work', re: /Beads owns durable work/ },
  { name: 'Bead is the prompt', re: /Bead is the prompt/i },
  { name: 'bd ready', re: /bd ready/ },
  { name: 'bd show', re: /bd show/ },
  { name: 'bd update --claim', re: /bd update\b[^\n]{0,40}--claim/ },
  { name: 'bd close', re: /bd close/ },
  { name: 'bd prime', re: /bd prime/ },
  { name: 'bd hooks install', re: /bd hooks install/ },
  { name: '@beads/bd required', re: /@beads\/bd/ },
  { name: 'bd init', re: /bd init/ },
  { name: 'bd doctor', re: /bd doctor/ },
  { name: 'bd-workflow fragment', re: /bd-workflow/ },
  { name: 'bv triage', re: /\bbv\b/ },
];

// file (repo-relative) -> pattern names explicitly permitted, with the reason
// living beside the match in source. A stale entry (matches nothing) fails:
// the allowlist must describe reality, not accumulate.
const ALLOWLIST: Record<string, string[]> = {
  // The fixed doctor hint names the retired fragment only to redirect away
  // from it (`--list`; bd-workflow is retired Beads doctrine).
  'cli/src/commands/doctor.ts': ['bd-workflow fragment'],
  // The parity guard regex for bv names the token it forbids (self-match).
  'cli/src/tests/agent-contract-parity.test.ts': ['bv triage'],
};

function managedSection(file: string): string {
  const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split(/\r?\n/);
  const i = lines.findIndex((line) => line.trim() === START);
  const j = lines.findIndex((line, index) => index > i && line.trim() === END);
  if (i === -1 || j === -1) throw new Error(`${file}: contract markers missing`);
  return lines.slice(i + 1, j).join('\n');
}

describe('substrate doctrine anti-regression (ADR section 49)', () => {
  it('migrated sources carry no normative Beads content', () => {
    const violations: string[] = [];
    const usedAllowlist = new Set<string>();
    const check = (file: string, text: string) => {
      for (const { name, re } of PATTERNS) {
        if (!re.test(text)) continue;
        const key = `${file} :: ${name}`;
        if ((ALLOWLIST[file] ?? []).includes(name)) {
          usedAllowlist.add(key);
          continue;
        }
        violations.push(`${file}: normative Beads content (${name})`);
      }
    };
    for (const file of WHOLE_FILES) check(file, fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    for (const file of MANAGED_BLOCK_FILES) check(file, managedSection(file));
    expect(violations).toEqual([]);
    // No stale allowlist entries: every exception must still match something.
    const expected = Object.entries(ALLOWLIST).flatMap(([file, names]) => names.map((name) => `${file} :: ${name}`));
    expect([...usedAllowlist].sort()).toEqual(expected.sort());
  });
});
