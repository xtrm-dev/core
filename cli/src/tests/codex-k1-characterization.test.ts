import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildBareTmuxPlan,
  chooseAttachCommand,
} from '../utils/worktree-session.js';

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/codex/0.146.0',
);

type FixtureMetadata = {
  schema_version: string;
  runtime: {
    product: string;
    version: string;
    executable_source: string;
  };
  capture: {
    captured_at: string;
    surface: string;
    command: string[];
    config_root: string;
    redactions: string[];
  };
};

function readMetadata(): FixtureMetadata {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'metadata.json'), 'utf8')) as FixtureMetadata;
}

function readEvents(): Array<Record<string, unknown>> {
  return fs.readFileSync(path.join(fixtureRoot, 'exec-success.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('K1 runtime characterization', () => {
  it('freezes the released Pi and Claude launcher argv and identity baseline', () => {
    const shared = {
      sessionDisplayName: 'workspace-core-k1',
      sessionSlug: 'k1-baseline',
      issue: 'xtrm-ozknq.5',
      parentSessionId: '$41',
      worktreePath: '/workspace/core-k1',
      branchName: 'feature/xtrm-ozknq-5-characterization',
      turn1Body: 'characterize only',
      modelOverride: 'baseline-model',
      passthrough: ['--verbose'],
    };

    const pi = buildBareTmuxPlan({
      ...shared,
      runtime: 'pi',
      thinkingOverride: 'high',
      explicitSkillPaths: ['/skills/multiplexing-team'],
    });
    const claude = buildBareTmuxPlan({ ...shared, runtime: 'claude' });

    expect(pi).toMatchObject({
      sessionName: 'pi-k1-baseline',
      runtimeCmd: 'pi',
      runtimeArgs: [
        '--name', 'workspace-core-k1',
        '--skill', '/skills/multiplexing-team',
        '--model', 'baseline-model',
        '--thinking', 'high',
        '--verbose',
        'characterize only',
      ],
    });
    expect(claude).toMatchObject({
      sessionName: 'claude-k1-baseline',
      runtimeCmd: 'claude',
      runtimeArgs: [
        '--name', 'workspace-core-k1',
        '--dangerously-skip-permissions',
        '--model', 'baseline-model',
        '--verbose',
        '--',
        'characterize only',
      ],
    });
    expect(pi.paneOptions).toEqual(claude.paneOptions);
    expect(chooseAttachCommand('pi-k1-baseline', true)).toEqual(['switch-client', '-t', 'pi-k1-baseline']);
    expect(chooseAttachCommand('pi-k1-baseline', false)).toEqual(['attach-session', '-t', 'pi-k1-baseline']);
  });

  it('accepts only versioned and redacted Codex exec fixtures', () => {
    const metadata = readMetadata();
    const events = readEvents();

    expect(metadata).toMatchObject({
      schema_version: 'xtrm.codex.fixture-metadata.v1',
      runtime: { product: 'codex-cli', version: '0.146.0' },
      capture: {
        captured_at: '2026-08-02',
        surface: 'exec-jsonl',
        config_root: 'ignored with --ignore-user-config',
      },
    });
    expect(metadata.runtime.executable_source).toBe(
      '<CODEX_HOME>/packages/standalone/releases/0.146.0-x86_64-unknown-linux-musl/bin/codex',
    );
    expect(metadata.capture.command).toContain('--ephemeral');
    expect(metadata.capture.redactions).toContain('thread_id');
    expect(metadata.capture.redactions).toContain('executable_source_home');

    expect(events.map((event) => event.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'item.completed',
      'turn.completed',
    ]);
    expect(events[0]).toEqual({ type: 'thread.started', thread_id: '<redacted-thread-id>' });
    expect(events[3]).toMatchObject({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'CODEX_K1_OK' },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'turn.completed',
      usage: {
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
      },
    });

    const serialized = JSON.stringify({ metadata, events });
    const userHomePath = /\/(?:home|Users)\/[^/"\s]+/;
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(serialized).not.toMatch(userHomePath);
    expect('/home/sam/.codex').toMatch(userHomePath);
  });
});
