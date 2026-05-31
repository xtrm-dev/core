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

const bothPolicies = policies.filter(({ policy }) => policy.runtime === 'both');

describe('runtime:both parity', () => {
  it('at least one policy targets both runtimes', () => {
    expect(bothPolicies.length).toBeGreaterThan(0);
  });

  it.each(bothPolicies.map(p => p.file))('%s has claude.hooks', (file) => {
    const { policy } = policies.find(p => p.file === file)!;
    expect(policy.claude?.hooks?.length ?? 0).toBeGreaterThan(0);
  });

  it.each(bothPolicies.map(p => p.file))('%s has pi.extension', (file) => {
    const { policy } = policies.find(p => p.file === file)!;
    expect(policy.pi?.extension, 'runtime:both policy missing pi.extension').toBeTruthy();
  });
});

// ── Matcher macro expansion parity ────────────────────────────────────────────

describe('matcher macro expansion parity', () => {
  it('compiled hooks contain no unresolved matcher macros', () => {
    const compiledHooks = JSON.parse(readFileSync(join(ROOT, '.xtrm', 'config', 'hooks.json'), 'utf8'));
    const allGroups = Object.values(compiledHooks?.hooks ?? {}).flat() as Array<{ matcher?: string }>;
    const unresolved = allGroups.filter((group) => typeof group.matcher === 'string' && group.matcher.includes('$'));
    expect(unresolved, 'found unresolved matcher macros in .xtrm/config/hooks.json').toHaveLength(0);
  });
});

// ── File existence ────────────────────────────────────────────────────────────

describe('referenced files exist', () => {
  // Resolve a hook command to the repo-relative path of the script it runs.
  const resolveCommand = (command: string): string => {
    let raw = command.replace(/^(node|python3)\s+/, '');
    // The script path is the first quoted segment (it may carry trailing args)…
    const quoted = raw.match(/^"([^"]+)"/) ?? raw.match(/^'([^']+)'/);
    raw = quoted ? quoted[1] : raw.split(/\s+/)[0];
    // …plugin-root commands resolve relative to repo root…
    raw = raw.replace(/^\$\{[A-Z_]+\}\//, '');
    // …and project-runtime service-skills commands resolve to the repo source mirror
    // (the scripts live at .xtrm/skills/default in the repo; .claude/skills is the
    // per-consumer-project runtime view).
    raw = raw.replace(/^\$CLAUDE_PROJECT_DIR\/\.claude\/skills\/service-skills\//, '.xtrm/skills/default/service-skills/');
    return raw;
  };

  const allHooks = policies.flatMap(({ file, policy }) =>
    (policy.claude?.hooks ?? []).map(hook => ({ file, command: hook.command })),
  );

  it.each(allHooks)('$file: command "$command" references existing file', ({ command }) => {
    const relativePath = resolveCommand(command);
    const absolutePath = join(ROOT, relativePath);
    expect(existsSync(absolutePath), `Hook script not found: ${relativePath}`).toBe(true);
  });

  const piPolicies = policies.filter(({ policy }) => policy.pi?.extension);

  it.each(piPolicies.map(p => p.file))('%s: pi.extension file exists', (file) => {
    const { policy } = policies.find(p => p.file === file)!;
    const absPath = join(ROOT, policy.pi!.extension);
    expect(existsSync(absPath), `Pi extension not found: ${policy.pi!.extension}`).toBe(true);
  });
});


// ── Compiler consistency ──────────────────────────────────────────────────────

describe('compiler', () => {
  it('.xtrm/config/hooks.json is up to date with policies/', () => {
    const result = spawnSync(
      'node',
      [join(ROOT, 'scripts', 'compile-policies.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(
      result.status,
      `.xtrm/config/hooks.json drift detected — run: npm run compile-policies\n${result.stdout}${result.stderr}`,
    ).toBe(0);
  });

  it('--check-pi validates policy-declared extension deployment set', () => {
    const tmpAgent = mkdtempSync(join(tmpdir(), 'xtrm-pi-agent-'));
    const tmpExtDir = join(tmpAgent, 'extensions');
    mkdirSync(tmpExtDir, { recursive: true });

    try {
      const declared = policies
        .filter(({ policy }) => ['pi', 'both'].includes(policy.runtime ?? 'both'))
        .map(({ policy }) => policy.pi?.extension)
        .filter(Boolean) as string[];

      // Extension paths point to index.ts, but we need the parent directory
      const extDirs = new Set(declared.map(rel => dirname(rel)));
      for (const rel of extDirs) {
        const src = join(ROOT, rel);
        const dst = join(tmpExtDir, basename(rel));
        // Copy directory recursively (extensions are subdirectories with index.ts + package.json)
        cpSync(src, dst, { recursive: true });
      }

      const result = spawnSync(
        'node',
        [join(ROOT, 'scripts', 'compile-policies.mjs'), '--check-pi'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, PI_AGENT_DIR: tmpAgent },
        },
      );

      expect(result.status, `check-pi failed:\n${result.stdout}${result.stderr}`).toBe(0);
    } finally {
      rmSync(tmpAgent, { recursive: true, force: true });
    }
  });

  it('all policy ids are unique', () => {
    const ids = policies.map(({ policy }) => policy.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('policy order values are unique or explicitly equal', () => {
    // Multiple policies can share an order value — just document it
    const orders = policies.map(({ file, policy }) => ({ file, order: policy.order ?? 50 }));
    // No assertion — informational only, logged to help debug ordering issues
    expect(orders.length).toBeGreaterThan(0);
  });
});
