import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_PROMPT_END_MARKER as END,
  GLOBAL_PROMPT_START_MARKER as START,
  GlobalPromptSyncError,
  readCanonicalGlobalPromptBody,
  renderManagedGlobalPrompt,
  resolveGlobalPromptTargets,
  syncGlobalPrompts,
} from '../core/global-prompt-sync.js';
import { resolvePackageRoot } from '../core/registry-scaffold.js';

// Frozen copy of the pre-marker APPEND_SYSTEM.md body (as it ships today) so
// the legacy-migration behavior is tested against the real historical shape,
// not against whatever the module constant happens to say.
const LEGACY_BODY = `Programmatic tool calling and command chaining:

When a task needs several independent operations, run them in one bash call or one python cell instead of one model round trip per operation. Batch, filter, and aggregate inside the call so only the answer reaches the context window.

- Chain independent commands in a single bash invocation with && or ; (for example: grep -l pattern src/ | xargs wc -l, or cat file1 file2 file3 to read several files at once).
- Loop in the shell for fan-out work (for example: for d in */; do ...; done) instead of repeating tool calls one by one.
- Filter and summarize before reporting: pipe through grep, head, wc, sort, or jq; return counts, top-N, and matching lines rather than raw dumps, unless the user asked for full output.
- Prefer the python tool for multi-step processing, parsing, aggregation, and fan-out: one cell replaces many round trips, and named variables persist across cells. When the python tool is unavailable, one python3 -c or heredoc run replaces many round trips.
- python state (variables, imports, functions) persists across calls until reset: true; pass reset when the scratch namespace is no longer needed. os.chdir() inside a cell persists; reset returns to the working directory.
- Keep dependent steps sequential when a later command must be decided from an earlier result; for the python tool, state carries between sequential calls.
- Batch independent work into one call.
- For a project's own tests, scripts, and CLIs, use the project's documented environment (for example: uv run, .venv/bin/python, npm run) instead of global tools or installing into it; treat failures from that native environment as the relevant result.
- Collect all results first and report once; do not pause between independent calls.
- Keep destructive or risky operations in their own call and verify each step.
- Use ; instead of && when you must see partial output after a failure.`;

const CANONICAL = `Programmatic tool calling and command chaining:

When a task needs several independent operations, run them in one bash call or one tool call instead of one model round trip per operation. Batch, filter, and aggregate inside the call so only the answer reaches the context window.

- Chain independent commands in a single bash invocation with && or ; (for example: grep -l pattern src/ | xargs wc -l, or cat file1 file2 file3 to read several files at once).
- Loop in the shell for fan-out work (for example: for d in */; do ...; done) instead of repeating tool calls one by one.
- Filter and summarize before reporting: pipe through grep, head, wc, sort, or jq; return counts, top-N, and matching lines rather than raw dumps, unless the user asked for full output.
- Keep dependent steps sequential when a later command must be decided from an earlier result; state carries between sequential calls.
- Batch independent work into one call.
- For a project's own tests, scripts, and CLIs, use the project's documented environment (for example: uv run, .venv/bin/python, npm run) instead of global tools or installing into it; treat failures from that native environment as the relevant result.
- Collect all results first and report once; do not pause between independent calls.
- Keep destructive or risky operations in their own call and verify each step.
- Use ; instead of && when you must see partial output after a failure.`;

const BLOCK = `${START}\n${CANONICAL.trim()}\n${END}`;

// Phrasing that only the pi-specific canonical asset carries: it must reach the
// pi prompt and must never appear in another host's prompt.
const PI_ONLY_MARKER = 'every session tool is a tools.* method';

let tempRoot = '';
let previousHome: string | undefined;
let previousAgentDir: string | undefined;
let previousCodingAgentDir: string | undefined;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-global-prompt-'));
  previousHome = process.env.HOME;
  previousAgentDir = process.env.PI_AGENT_DIR;
  previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const testHome = path.join(tempRoot, 'home');
  process.env.HOME = testHome;
  // PI_AGENT_DIR is inert for this suite since the pi target was deprecated
  // (XT-138/XT-139) — resolveGlobalPromptTargets no longer reads it — but
  // keep it sandboxed alongside HOME so no test can touch the real agent dir.
  process.env.PI_AGENT_DIR = path.join(testHome, '.pi', 'agent');
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = previousAgentDir;
  if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
  await fs.remove(tempRoot);
  vi.restoreAllMocks();
});

function opts(extra: Record<string, unknown> = {}) {
  return {
    canonicalBody: CANONICAL,
    home: process.env.HOME,
    ...extra,
  };
}

describe('renderManagedGlobalPrompt', () => {
  it('creates a marked block for empty content', () => {
    const result = renderManagedGlobalPrompt('', CANONICAL);
    expect(result.action).toBe('create');
    expect(result.next).toBe(`${BLOCK}\n`);
  });

  it('replaces the legacy whole-file body without duplication', () => {
    const result = renderManagedGlobalPrompt(`${LEGACY_BODY}\n`, CANONICAL);
    expect(result.action).toBe('replace-whole-file');
    expect(result.next).toBe(`${BLOCK}\n`);
    expect(result.next).not.toContain('one python cell');
    expect(result.next).not.toContain('os.chdir');
  });

  it('normalizes an unmarked canonical body into the marked form', () => {
    const result = renderManagedGlobalPrompt(`${CANONICAL}`, CANONICAL);
    expect(result.action).toBe('replace-whole-file');
    expect(result.next).toBe(`${BLOCK}\n`);
  });

  it('preserves all bytes outside one exact marker pair', () => {
    const existing = `# my notes\n\n${START}\nold managed body\n${END}\n\nuser tail: ${'x'.repeat(50)}`;
    const result = renderManagedGlobalPrompt(existing, CANONICAL);
    expect(result.action).toBe('replace-block');
    expect(result.next).toBe(`# my notes\n\n${BLOCK}\n\nuser tail: ${'x'.repeat(50)}`);
    expect(result.next).not.toContain('old managed body');
  });

  it('is idempotent across repeated renders', () => {
    const first = renderManagedGlobalPrompt('', CANONICAL);
    const second = renderManagedGlobalPrompt(first.next, CANONICAL);
    expect(second.action).toBe('unchanged');
    expect(second.next).toBe(first.next);
  });

  it('fails closed on an orphan start marker', () => {
    expect(() => renderManagedGlobalPrompt(`${START}\nbody without end`, CANONICAL)).toThrow(GlobalPromptSyncError);
  });

  it('fails closed on an orphan end marker', () => {
    expect(() => renderManagedGlobalPrompt(`body without start\n${END}`, CANONICAL)).toThrow(GlobalPromptSyncError);
  });

  it('fails closed on duplicate start markers', () => {
    expect(() => renderManagedGlobalPrompt(`${START}\n${START}\nbody\n${END}`, CANONICAL)).toThrow(/duplicate|nested/);
  });

  it('fails closed on duplicate end markers', () => {
    expect(() => renderManagedGlobalPrompt(`${START}\nbody\n${END}\n${END}`, CANONICAL)).toThrow(/duplicate|nested/);
  });

  it('fails closed on an out-of-order pair', () => {
    expect(() => renderManagedGlobalPrompt(`${END}\n${START}`, CANONICAL)).toThrow(GlobalPromptSyncError);
  });

  it('prepends a marked block to unrelated user content, preserving it verbatim', () => {
    const user = 'my custom append-system content\nline two';
    const result = renderManagedGlobalPrompt(user, CANONICAL);
    expect(result.action).toBe('prepend');
    expect(result.next).toBe(`${BLOCK}\n\n${user}`);
  });

  it('keeps CRLF line endings and preserves user bytes verbatim (xtrm-3ljgz.2 review fix)', () => {
    const existing = `# user header\r\n\r\n${START}\r\nold managed body\r\n${END}\r\n\r\nuser tail`;
    const result = renderManagedGlobalPrompt(existing, CANONICAL);
    expect(result.action).toBe('replace-block');
    expect(result.next).toBe(`# user header\r\n\r\n${START}\r\n${CANONICAL.trim()}\r\n${END}\r\n\r\nuser tail`);
  });

  it('is byte-idempotent for a CRLF block-only target (xtrm-3ljgz.2 review fix)', () => {
    const blockCRLF = `${START}\r\n${CANONICAL.trim()}\r\n${END}\r\n`;
    const result = renderManagedGlobalPrompt(blockCRLF, CANONICAL);
    expect(result.action).toBe('unchanged');
    expect(result.next).toBe(blockCRLF);
  });

  it('converges an all-CRLF marked file (Windows-saved) to canonical body on run 1, then idempotent (xtrm-3ljgz.2 review fix)', () => {
    const allCRLFBlock = `${START}\r\n${CANONICAL.trim().replace(/\n/g, '\r\n')}\r\n${END}`;
    const existing = `# user header\r\n\r\n${allCRLFBlock}\r\n\r\n# user tail\r\n`;
    const first = renderManagedGlobalPrompt(existing, CANONICAL);
    expect(first.action).toBe('replace-block');
    expect(first.next.startsWith('# user header\r\n\r\n')).toBe(true);
    expect(first.next.endsWith('\r\n\r\n# user tail\r\n')).toBe(true);
    const second = renderManagedGlobalPrompt(first.next, CANONICAL);
    expect(second.action).toBe('unchanged');
    expect(second.next).toBe(first.next);
  });

  it('migrates a CRLF legacy whole-file body into the marked form without duplication', () => {
    const result = renderManagedGlobalPrompt(`${LEGACY_BODY}\r\n`, CANONICAL);
    expect(result.action).toBe('replace-whole-file');
    expect(result.next).toBe(`${START}\r\n${CANONICAL.trim()}\r\n${END}\r\n`);
  });

  it('prepends a marked block to CRLF user content, preserving its bytes verbatim', () => {
    const user = '# crlf user\r\nline two\r\n';
    const result = renderManagedGlobalPrompt(user, CANONICAL);
    expect(result.action).toBe('prepend');
    expect(result.next).toBe(`${START}\r\n${CANONICAL.trim()}\r\n${END}\r\n\r\n${user}`);
  });
});

describe('per-target canonical assets', () => {
  it('prefers the shared body for claude and keeps pi on its deprecation pointer', async () => {
    const pi = await readCanonicalGlobalPromptBody('pi');
    const claude = await readCanonicalGlobalPromptBody('claude');
    const shared = await readCanonicalGlobalPromptBody();

    expect(pi).toContain('DEPRECATED');
    expect(pi).toContain('xtrm-primer');
    expect(pi).not.toBe(shared);
    expect(claude).toBe(shared);
  });

  it('carries the mandatory framing in the managed canonical body', async () => {
    expect(await readCanonicalGlobalPromptBody('claude')).toContain('MANDATORY');
    expect(await readCanonicalGlobalPromptBody()).toContain('MANDATORY');
  });

  it('syncs only the claude target on the production path and leaves any pi file alone', async () => {
    const piFile = path.join(process.env.HOME as string, '.pi', 'agent', 'APPEND_SYSTEM.md');
    await fs.outputFile(piFile, 'operator notes stay');
    const result = await syncGlobalPrompts({ home: process.env.HOME as string });
    expect(result.targets.map((t) => t.label)).toEqual(['claude']);

    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    expect(await fs.readFile(claudeFile, 'utf8')).toContain('MANDATORY');
    expect(await fs.readFile(claudeFile, 'utf8')).not.toContain(PI_ONLY_MARKER);
    expect(await fs.readFile(piFile, 'utf8')).toBe('operator notes stay');
  });
});

describe('syncGlobalPrompts', () => {
  it('creates the claude target when missing and never creates a pi APPEND_SYSTEM.md', async () => {
    const result = await syncGlobalPrompts(opts());
    expect(result.targets.map((t) => t.action)).toEqual(['create']);

    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(`${BLOCK}\n`);
    expect(fs.existsSync(path.join(process.env.HOME as string, '.pi', 'agent', 'APPEND_SYSTEM.md'))).toBe(false);
  });

  it('leaves a legacy pi APPEND_SYSTEM.md untouched (deprecated target, transition)', async () => {
    const piFile = path.join(process.env.HOME as string, '.pi', 'agent', 'APPEND_SYSTEM.md');
    const legacy = `# operator notes\n\n${START}\nold doctrine\n${END}\n`;
    await fs.outputFile(piFile, legacy);

    const result = await syncGlobalPrompts(opts());
    expect(result.targets.map((t) => t.label)).toEqual(['claude']);
    expect(await fs.readFile(piFile, 'utf8')).toBe(legacy); // untouched
  });

  it('never manages any APPEND_SYSTEM.md, so project overrides keep Pi-native precedence', async () => {
    await syncGlobalPrompts(opts());
    const targets = resolveGlobalPromptTargets({ home: process.env.HOME as string });
    expect(targets.map((t) => t.label)).toEqual(['claude']);
    for (const target of targets) expect(path.basename(target.file)).not.toBe('APPEND_SYSTEM.md');
  });

  it('migrates the legacy whole-file body once and stays idempotent', async () => {
    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    await fs.outputFile(claudeFile, `${LEGACY_BODY}\n`);

    const first = await syncGlobalPrompts(opts());
    expect(first.targets[0].action).toBe('replace-whole-file');
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(`${BLOCK}\n`);

    const second = await syncGlobalPrompts(opts());
    expect(second.targets[0].action).toBe('unchanged');
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(`${BLOCK}\n`);
  });

  it('preserves user bytes outside the marked block on apply', async () => {
    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    await fs.outputFile(claudeFile, `# user header\n\n${START}\nold\n${END}\n\nuser tail`);

    const result = await syncGlobalPrompts(opts());
    expect(result.targets[0].action).toBe('replace-block');
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(`# user header\n\n${BLOCK}\n\nuser tail`);
  });

  it('dry-run reports without writing', async () => {
    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    await fs.outputFile(claudeFile, `${LEGACY_BODY}\n`);

    const result = await syncGlobalPrompts(opts({ dryRun: true }));
    expect(result.targets[0].dryRun).toBe(true);
    expect(result.targets[0].changed).toBe(true);
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(`${LEGACY_BODY}\n`); // untouched
  });

  it('fails closed on a symlink target without writing', async () => {
    const claudeDir = path.join(process.env.HOME as string, '.claude');
    await fs.ensureDir(claudeDir);
    await fs.symlink('/tmp/nonexistent-target', path.join(claudeDir, 'CLAUDE.md'));

    await expect(syncGlobalPrompts(opts())).rejects.toThrow(/symlink/);
    expect((await fs.lstat(path.join(claudeDir, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
  });

  it('backs up the pre-write file under ~/.xtrm/migration-backups', async () => {
    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    await fs.outputFile(claudeFile, `${LEGACY_BODY}\n`);

    await syncGlobalPrompts(opts());

    const backups = path.join(process.env.HOME as string, '.xtrm', 'migration-backups');
    const files = await fs.readdir(backups);
    expect(files.length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(backups, files[0]), 'utf8')).toBe(`${LEGACY_BODY}\n`);
  });

  it('preserves the target file mode', async () => {
    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    await fs.outputFile(claudeFile, `${LEGACY_BODY}\n`);
    await fs.chmod(claudeFile, 0o600);

    await syncGlobalPrompts(opts());

    const stat = await fs.stat(claudeFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('refuses to write when the file changed between plan and write', async () => {
    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    const original = `${LEGACY_BODY}\n`;
    await fs.outputFile(claudeFile, original);

    const readSpy = vi.spyOn(fs, 'readFile');
    readSpy.mockImplementation(async (file: any, ...rest: any[]) => {
      if (String(file).endsWith('CLAUDE.md')) {
        // First call is the plan read, subsequent calls are the defense re-read.
        readSpy.mockImplementation(async (f: any) => String(f).endsWith('CLAUDE.md') ? `${original}// concurrent edit` : await fs.readFile(f, 'utf8'));
        return original;
      }
      return await fs.readFile(file as string, rest[0] as BufferEncoding);
    });

    await expect(syncGlobalPrompts(opts())).rejects.toThrow(/concurrent modification/);
    readSpy.mockRestore();
    expect(await fs.readFile(claudeFile, 'utf8')).toBe(original); // untouched
  });
});

describe('per-target routing (production path, no canonicalBody)', () => {
  it('resolves exactly the claude target — fails if a target is mis-wired', () => {
    const targets = resolveGlobalPromptTargets({ home: process.env.HOME as string });
    expect(targets.map((t) => t.label)).toEqual(['claude']);
  });

  it('syncs the claude production asset and writes no pi file', async () => {
    const result = await syncGlobalPrompts({ home: process.env.HOME as string });
    expect(result.targets.map((t) => t.label)).toEqual(['claude']);

    const claudeFile = path.join(process.env.HOME as string, '.claude', 'CLAUDE.md');
    const claudeContent = await fs.readFile(claudeFile, 'utf8');
    const shared = await readCanonicalGlobalPromptBody();

    expect(claudeContent).toContain('MANDATORY');
    expect(claudeContent).not.toContain(PI_ONLY_MARKER);
    // The managed claude file carries the shared body, nothing host-specific.
    expect(claudeContent).toContain(shared.trim());
    expect(fs.existsSync(path.join(process.env.HOME as string, '.pi', 'agent', 'APPEND_SYSTEM.md'))).toBe(false);
  });

  it('falls back to the shared body for claude, codex, and unknown labels', async () => {
    const shared = await readCanonicalGlobalPromptBody();
    expect(await readCanonicalGlobalPromptBody('claude')).toBe(shared);
    // Codex has no managed global file; its doctrine travels per launch via
    // developer_instructions, so it intentionally falls back to shared.
    expect(await readCanonicalGlobalPromptBody('codex')).toBe(shared);
    expect(await readCanonicalGlobalPromptBody('unknown-host')).toBe(shared);
    expect(await readCanonicalGlobalPromptBody('pi')).not.toBe(shared);
  });

  it('shared fallback never names the pi-only codemode skill', async () => {
    const shared = await readCanonicalGlobalPromptBody();
    expect(shared).toContain('MANDATORY');
    expect(shared).not.toMatch(/codemode/i);
  });

  it('pi asset is a deprecation pointer, not doctrine (single vehicle is the primer)', async () => {
    const pi = await readCanonicalGlobalPromptBody('pi');
    expect(pi).toContain('DEPRECATED');
    expect(pi).toContain('xtrm-primer');
    // No doctrine ships here anymore: the primer folds it with audit fixes.
    expect(pi).not.toContain('MANDATORY');
    expect(pi).not.toContain(PI_ONLY_MARKER);
    expect(pi).not.toContain('Promise.allSettled');
  });

  it('codemode skill gates the writer pre-flight pattern behind explicit scope', async () => {
    const skillPath = path.join(resolvePackageRoot(), '.xtrm', 'skills', 'default', 'codemode', 'SKILL.md');
    const skill = await fs.readFile(skillPath, 'utf8');
    expect(skill).toMatch(/writer pre-flight.*explicit scope only/i);
    expect(skill).toMatch(/OFF unless the pinned contract/i);
  });

  it('review writer pre-flight lane is explicit-scope only', async () => {
    const reviewPath = path.join(
      resolvePackageRoot(),
      '.xtrm',
      'skills',
      'default',
      'engineering-quality',
      'references',
      'review.md',
    );
    const review = await fs.readFile(reviewPath, 'utf8');
    expect(review).toMatch(/Writer pre-flight.*explicit scope only/i);
    expect(review).toMatch(/OFF unless the pinned contract/i);
  });
});
