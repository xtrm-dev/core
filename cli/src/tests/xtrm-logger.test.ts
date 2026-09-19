import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const loggerUrl = new URL('../../../.xtrm/hooks/xtrm-logger.mjs', import.meta.url);

async function loadLogger(): Promise<{ logEvent: (params: Record<string, unknown>) => void }> {
  return import(`${loggerUrl.href}?test=${Date.now()}`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('xtrm hook logger', () => {
  it('persists events without an sqlite3 executable on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xtrm-logger-'));
    tempDirs.push(root);
    // Lane 1 (hook cleanup): logger anchors on .xtrm/, not retired .beads/.
    await mkdir(join(root, '.xtrm'));
    const previousPath = process.env.PATH;
    process.env.PATH = join(root, 'empty-bin');

    try {
      const { logEvent } = await loadLogger();
      logEvent({
        cwd: root,
        sessionId: 'session-1',
        runtime: 'pi',
        kind: 'bd.claimed',
        outcome: 'allow',
        issueId: 'xtrm-123',
        data: { source: 'test' },
      });
    } finally {
      process.env.PATH = previousPath;
    }

    const db = new DatabaseSync(join(root, '.xtrm', 'debug.db'), { readOnly: true });
    const row = db.prepare('SELECT session_id, runtime, kind, outcome, issue_id, data FROM events').get();
    db.close();

    expect(row).toEqual({
      session_id: 'session-1',
      runtime: 'pi',
      kind: 'bd.claimed',
      outcome: 'allow',
      issue_id: 'xtrm-123',
      data: '{"source":"test"}',
    });
  });

  it('remains fail-open when event data cannot be serialized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xtrm-logger-'));
    tempDirs.push(root);
    await mkdir(join(root, '.beads'));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { logEvent } = await loadLogger();

    expect(() => logEvent({ cwd: root, sessionId: 'session-1', kind: 'tool.call', data: circular })).not.toThrow();
  });
});
