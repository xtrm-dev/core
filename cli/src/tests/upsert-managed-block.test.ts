import { describe, expect, it } from 'vitest';
import { upsertManagedBlock } from '../commands/init.js';

const START = '<!-- xtrm:start -->';
const END = '<!-- xtrm:end -->';

describe('upsertManagedBlock', () => {
  it('prepends a managed block to an empty file', () => {
    const out = upsertManagedBlock('', 'body content');
    expect(out).toBe(`${START}\nbody content\n${END}\n`);
  });

  it('prepends a managed block to a file with existing user content', () => {
    const existing = '# User header\n\nuser content here\n';
    const out = upsertManagedBlock(existing, 'body content');
    expect(out).toBe(`${START}\nbody content\n${END}\n\n${existing}`);
  });

  it('replaces an existing single managed block in place', () => {
    const existing = [
      `${START}`,
      'old body',
      `${END}`,
      '',
      'user tail',
    ].join('\n');
    const out = upsertManagedBlock(existing, 'new body');
    expect(out).toBe([
      `${START}`,
      'new body',
      `${END}`,
      '',
      'user tail',
    ].join('\n'));
  });

  // xtrm-ya67 regression: a previous lazy-regex version of this function only
  // replaced the first start..end pair, leaving a duplicate content block +
  // orphan end marker behind. The greedy variant sweeps the entire span.
  it('collapses duplicate managed-block content and trailing orphan end marker (xtrm-ya67)', () => {
    const corrupted = [
      `${START}`,                 // line 0 — legitimate managed block opens
      '# XTRM Agent Workflow',
      'old managed body',
      `${END}`,                   // line 3 — legitimate managed block closes
      '',
      '# XTRM Agent Workflow',    // line 5 — duplicate content (no start)
      'duplicated body',
      `${END}`,                   // line 7 — orphan end marker
      '',
      'real user content here',   // line 9 — actual user tail
    ].join('\n');

    const out = upsertManagedBlock(corrupted, 'fresh body');

    // Exactly one start, one end.
    expect(out.match(new RegExp(START, 'g'))?.length).toBe(1);
    expect(out.match(new RegExp(END, 'g'))?.length).toBe(1);
    // Old + duplicated bodies removed.
    expect(out).not.toContain('old managed body');
    expect(out).not.toContain('duplicated body');
    expect(out).not.toContain('# XTRM Agent Workflow');
    // User tail preserved.
    expect(out).toContain('real user content here');
    // Output well-formed.
    expect(out).toContain(`${START}\nfresh body\n${END}`);
  });

  it('is idempotent across repeated upserts with the same body', () => {
    const initial = upsertManagedBlock('', 'stable body');
    const second = upsertManagedBlock(initial, 'stable body');
    expect(second).toBe(initial);
  });

  it('preserves user content tail across replacement', () => {
    const existing = [
      `${START}`,
      'managed v1',
      `${END}`,
      '',
      '# User notes',
      'note A',
      'note B',
    ].join('\n');
    const out = upsertManagedBlock(existing, 'managed v2');
    expect(out).toContain('# User notes');
    expect(out).toContain('note A');
    expect(out).toContain('note B');
    expect(out).toContain(`${START}\nmanaged v2\n${END}`);
  });
});
