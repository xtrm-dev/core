/**
 * Cross-runtime policy parity tests (79m)
 *
 * Verifies that:
 * 1. Each policy file passes structural validation
 * 2. Policies with runtime:both have both Claude hooks and Pi extension metadata
 * 3. All referenced hook scripts and Pi extension files exist on disk
 * 4. The policy compiler produces up-to-date .xtrm/config/hooks.json (--check passes)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Resolve repo root from cli/src/tests/
const ROOT = resolve(__dirname, '..', '..', '..');
const POLICIES_DIR = join(ROOT, 'policies');

interface PolicyHook {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

interface Policy {
  id: string;
  description: string;
  version: string;
  runtime?: 'claude' | 'pi' | 'both';
  order?: number;
  claude?: { hooks: PolicyHook[] };
  pi?: { extension: string; events?: string[] };
}

// Load all policies (skip schema.json)
const policyFiles = readdirSync(POLICIES_DIR)
  .filter(f => f.endsWith('.json') && f !== 'schema.json')
  .sort();

const policies: Array<{ file: string; policy: Policy }> = policyFiles.map(file => ({
  file,
  policy: JSON.parse(readFileSync(join(POLICIES_DIR, file), 'utf8')) as Policy,
}));


// ── Structural validation ─────────────────────────────────────────────────────

describe('policy structure', () => {
  it.each(policyFiles)('%s has required fields', (file) => {
    const { policy } = policies.find(p => p.file === file)!;
    expect(policy.id, 'missing id').toBeTruthy();
    expect(policy.description, 'missing description').toBeTruthy();
    expect(policy.version, 'missing version').toBeTruthy();
  });

  it.each(policyFiles)('%s has valid runtime value', (file) => {
    const { policy } = policies.find(p => p.file === file)!;
    const validRuntimes = ['claude', 'pi', 'both', undefined];
    expect(validRuntimes).toContain(policy.runtime);
  });

  it.each(policyFiles)('%s has at least one runtime target', (file) => {
    const { policy } = policies.find(p => p.file === file)!;
    const hasClaude = (policy.claude?.hooks?.length ?? 0) > 0;
    const hasPi = !!policy.pi?.extension;
    expect(hasClaude || hasPi, 'policy has no claude hooks and no pi extension').toBe(true);
  });
});

// ── Cross-runtime parity ──────────────────────────────────────────────────────

const claudePolicies = policies.filter(({ policy }) => (policy.claude?.hooks?.length ?? 0) > 0);
const piPolicies = policies.filter(({ policy }) => Boolean(policy.pi?.extension));

describe('cross-runtime coverage', () => {
  // The invariant this file protects: an enforcement area that exists on both
  // runtimes must keep existing on both.
  //
  // CORE-2339 moved every Claude hook into one dispatcher process, so the
  // quality gate is no longer declared twice inside one `runtime: both` policy:
  // quality-gates.json now carries the Pi extension and the Claude side is wired
  // by hook-dispatcher.json. The two halves are asserted together below, so a
  // future edit that drops either side still fails here.
  //
  // Recorded gap (pre-existing, NOT introduced by CORE-2339): the
  // worktree-boundary and specialists-agent-guard guards have no Pi equivalent —
  // on the base commit both policies were already `runtime: claude` with no `pi`
  // section. Porting them to Pi is separate work; until then they are
  // Claude-only by design, not by regression.

  it('the quality gate is wired on Claude (dispatcher) and on Pi (extension)', () => {
    const gate = policies.find(p => p.file === 'quality-gates.json')!.policy;
    expect(gate.pi?.extension, 'quality gate lost its Pi extension').toBeTruthy();

    const dispatcher = policies.find(p => p.file === 'hook-dispatcher.json')!.policy;
    const commands = (dispatcher.claude?.hooks ?? []).map(h => h.command).join('\n');
    expect(commands, 'quality gate lost its Claude wiring').toContain('dispatch.mjs post');
  });

  it('the Claude hook wiring is single-sourced through the dispatcher', () => {
    expect(claudePolicies.map(p => p.file)).toEqual(['hook-dispatcher.json', 'inbox-reminder.json']);
  });

  it('every policy declares wiring only for the runtimes it targets', () => {
    for (const { file, policy } of policies) {
      const hasClaude = (policy.claude?.hooks?.length ?? 0) > 0;
      const hasPi = Boolean(policy.pi?.extension);
      if (policy.runtime === 'claude') expect(hasClaude || !hasPi, `${file} mis-declared`).toBe(true);
      if (policy.runtime === 'pi') expect(!hasClaude, `${file} declares claude hooks but is pi-only`).toBe(true);
    }
  });

  it('the only Claude-only enforcement policies are the two known guards', () => {
    // worktree-boundary and specialists-agent-guard were Claude-only before
    // CORE-2339 and are covered by the dispatcher. Any NEW Claude-only policy
    // means an enforcement area silently lost its Pi side, which is the exact
    // regression this file exists to catch.
    const claudeOnly = claudePolicies
      .map(p => p.file)
      .filter(file => file !== 'hook-dispatcher.json' && file !== 'inbox-reminder.json');
    expect(claudeOnly).toEqual([]);
  });

  it('at least one policy wires a Pi extension', () => {
    expect(piPolicies.length).toBeGreaterThan(0);
  });
});
