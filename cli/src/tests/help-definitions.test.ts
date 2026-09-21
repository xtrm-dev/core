import { describe, expect, it } from 'vitest';

import { createHelpCommand } from '../commands/help.js';
import { createStatusCommand } from '../commands/status.js';
import { createUpdateCommand } from '../commands/update.js';
import { createDocsCommand } from '../commands/docs.js';
import { createEndCommand } from '../commands/end.js';
import { createMergeCommand } from '../commands/merge.js';
import { createDebugCommand } from '../commands/debug.js';
import { createSpecCommand } from '../commands/spec.js';
import { createTopologyCommand } from '../commands/topology.js';

async function renderHelp(): Promise<string> {
  let text = '';
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    text += s;
    return true;
  };
  try {
    await createHelpCommand().parseAsync(['node', 'xt']);
    return text;
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
}

function optionFlags(cmd: { options: Array<{ flags: string }> }): string[] {
  return cmd.options.map((o) => o.flags);
}

describe('xt help vs commander definitions (CORE-2321)', () => {
  it('help step numbering is sequential (no skipped numbers in CORE WORKFLOW)', async () => {
    const out = await renderHelp();
    expect(out).toContain('5) Manage old worktrees');
    expect(out).not.toMatch(/^  6\) Manage old worktrees/m);
  });

  it('help init options line covers the live init flags', async () => {
    const out = await renderHelp();
    for (const flag of ['--prune', '--substrate-dir', '--dry-run', '--yes', '--global']) {
      expect(out).toContain(flag);
    }
  });

  it('debug --type marks bd as legacy history', () => {
    const flags = createDebugCommand().options.map((o) => o.flags).join(' ');
    expect(flags).toContain('--type');
    const desc = createDebugCommand().options.find((o) => o.flags.includes('--type'))?.description ?? '';
    expect(desc).toContain('legacy Beads event history');
  });

  it('update/status/end/merge flags in help match commander definitions', async () => {
    const out = await renderHelp();
    // update
    expect(optionFlags(createUpdateCommand() as never)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('--strict-registry'),
        expect.stringContaining('--all-repos'),
      ]),
    );
    expect(out).toContain('--strict-registry');
    expect(out).toContain('--all-repos');
    // status
    expect(optionFlags(createStatusCommand() as never)).toEqual(
      expect.arrayContaining([expect.stringContaining('--check')]),
    );
    expect(out).toContain('[--check]');
    // end
    expect(optionFlags(createEndCommand() as never)).toEqual(
      expect.arrayContaining([expect.stringContaining('--dry-run')]),
    );
    expect(out).toContain('--dry-run');
    // merge: live defs have --override-authority and no --rebase
    expect(optionFlags(createMergeCommand() as never)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('--dry-run'),
        expect.stringContaining('--override-authority'),
      ]),
    );
    expect(createMergeCommand().options.map((o) => o.flags).join(' ')).not.toContain('--rebase');
    expect(out).toContain('--override-authority');
    expect(out).not.toContain('(FIFO, --rebase)');
  });

  it('commander descriptions name Substrate Issues, not bd/beads', () => {
    const descs = [
      createEndCommand().description,
      createDebugCommand().description,
      createSpecCommand().description,
      createTopologyCommand().description,
      createDocsCommand().description,
    ].join('\n');
    expect(descs).not.toMatch(/\bbd\b/);
    expect(descs).not.toMatch(/\bbeads\b/i);
  });

  it('help text names Issue flows, never bd-as-authority or origin/main', async () => {
    const out = await renderHelp();
    expect(out).not.toMatch(/closed bd issues/);
    expect(out).not.toMatch(/session\/bd lifecycle/);
    expect(out).not.toMatch(/Rebase to origin\/main/);
    expect(out).toContain('Subcommands: show, list, cross-check, verify');
  });

  it('docs command exposes the verify subcommand', () => {
    const names = createDocsCommand().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['show', 'list', 'cross-check', 'verify']));
  });
});
