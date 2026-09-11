import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSbProject,
  parseCreateProjectFlag,
  defaultStateDbPath,
  extractSbVersion,
  getSbDoctorJson,
  getSbProjectLink,
  getSbVersion,
  linkSbProject,
  parseSbEnvelope,
  resolveSbBin,
  resolveSetupTs,
  runSetupCheck,
  runSetupPlan,
  stateDbPresent,
  type SbRunner,
} from '../core/substrate.js';

// sb-consuming paths are covered with a mocked sb: either an injected stub
// runner or a fixture shell script behind XTRM_SB_BIN. Fixtures use the real
// `sb 0.1.0` envelope/data shapes (xtrm PRs #163/#168); the fresh-HOME live
// proof runs the real binary outside unit tests.

function stubRunner(routes: Record<string, { status: number | null; stdout?: string; stderr?: string }>): SbRunner {
  return (args) => {
    const route = routes[args[0] ?? ''] ?? routes[args.slice(0, 2).join(' ')] ?? { status: 1, stdout: '', stderr: 'unknown' };
    return { status: route.status, stdout: route.stdout ?? '', stderr: route.stderr ?? '' };
  };
}

let tmpDir = '';
let previousSbBin: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-substrate-test-'));
  previousSbBin = process.env.XTRM_SB_BIN;
});

afterEach(() => {
  fs.removeSync(tmpDir);
  if (previousSbBin === undefined) delete process.env.XTRM_SB_BIN;
  else process.env.XTRM_SB_BIN = previousSbBin;
  vi.restoreAllMocks();
});

describe('sb --version (confirmed contract: exit 0, parseable, no side effects)', () => {
  it('reports available with a parsed version on exit 0', () => {
    const info = getSbVersion(stubRunner({ '--version': { status: 0, stdout: 'sb 0.9.1\n' } }));
    expect(info.available).toBe(true);
    expect(info.version).toBe('0.9.1');
  });

  it('reports unavailable on non-zero exit', () => {
    const info = getSbVersion(stubRunner({ '--version': { status: 1, stdout: '', stderr: 'nope' } }));
    expect(info.available).toBe(false);
    expect(info.version).toBeUndefined();
  });

  it('reports unavailable when the binary is missing', () => {
    process.env.XTRM_SB_BIN = path.join(tmpDir, 'no-such-sb');
    expect(getSbVersion().available).toBe(false);
  });

  it('shells a fixture sb script behind XTRM_SB_BIN (mocked sb, real spawn path)', async () => {
    const script = path.join(tmpDir, 'sb');
    await fs.writeFile(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "sb 1.2.3"; exit 0; fi\nexit 1\n');
    await fs.chmod(script, 0o755);
    process.env.XTRM_SB_BIN = script;
    expect(resolveSbBin()).toBe(script);
    const info = getSbVersion();
    expect(info.available).toBe(true);
    expect(info.version).toBe('1.2.3');
  });

  it('extracts semver with prerelease suffixes', () => {
    expect(extractSbVersion('sb 1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(extractSbVersion('no version here')).toBeUndefined();
  });
});

const healthyDoctorEnvelope = {
  schema: 'substrate-cli/v1',
  command: 'doctor',
  ok: true,
  data: {
    dbPath: '/home/u/.xtrm/state.db',
    schemaHealthy: true,
    schemaError: null,
    projects: 1,
    link: { projectId: 'XTRM-1', source: 'env', gitRoot: '/repo' },
    linkError: null,
    gitRoot: '/repo',
  },
};

describe('sb doctor --json (verified: envelope + data keys, live sb 0.1.0)', () => {
  it('interprets a healthy envelope', () => {
    const info = getSbDoctorJson(undefined, stubRunner({ doctor: { status: 0, stdout: JSON.stringify(healthyDoctorEnvelope) } }));
    expect(info.ok).toBe(true);
    expect(info.payload).toEqual(healthyDoctorEnvelope);
    expect(info.data?.schemaHealthy).toBe(true);
    expect(info.data?.projects).toBe(1);
    expect(info.data?.link?.projectId).toBe('XTRM-1');
  });

  it('fails closed on non-zero exit', () => {
    const info = getSbDoctorJson(undefined, stubRunner({ doctor: { status: 1, stdout: '', stderr: 'boom' } }));
    expect(info.ok).toBe(false);
    expect(info.payload).toBeNull();
  });

  it('fails closed on unparseable stdout even with exit 0', () => {
    const info = getSbDoctorJson(undefined, stubRunner({ doctor: { status: 0, stdout: 'not json' } }));
    expect(info.ok).toBe(false);
    expect(info.error).toMatch(/unparseable/i);
  });

  it('fails closed when the envelope reports unhealthy schema', () => {
    const payload = { schema: 'substrate-cli/v1', command: 'doctor', ok: false, error: 'bad', data: { schemaHealthy: false } };
    const info = getSbDoctorJson(undefined, stubRunner({ doctor: { status: 0, stdout: JSON.stringify(payload) } }));
    expect(info.ok).toBe(false);
  });

  it('parses envelopes tolerantly without throwing', () => {
    expect(parseSbEnvelope('nope')).toBeNull();
    expect(parseSbEnvelope('[1,2]')?.ok).toBeUndefined();
  });
});

describe('sb project link/create (verified flags, live sb 0.1.0)', () => {
  it('links bare and with --project', () => {
    const calls: string[][] = [];
    const run: SbRunner = (args) => { calls.push(args); return { status: 0, stdout: 'linked\n', stderr: '' }; };
    expect(linkSbProject({ run }).ok).toBe(true);
    expect(calls[0]).toEqual(['project', 'link']);
    expect(linkSbProject({ project: 'XTRM-1', run }).ok).toBe(true);
    expect(calls[1]).toEqual(['project', 'link', '--project', 'XTRM-1']);
  });

  it('creates with prefix/name and optional id', () => {
    const calls: string[][] = [];
    const run: SbRunner = (args) => { calls.push(args); return { status: 0, stdout: 'created\n', stderr: '' }; };
    expect(createSbProject({ prefix: 'X', name: 'Demo', run }).ok).toBe(true);
    expect(calls[0]).toEqual(['project', 'create', '--prefix', 'X', '--name', 'Demo']);
  });

  it('parses the created project id for explicit linking', () => {
    const run: SbRunner = () => ({ status: 0, stdout: '{"id":"prj_9"}', stderr: '' });
    expect(createSbProject({ prefix: 'X', name: 'Demo', run }).projectId).toBe('prj_9');
    const runBare: SbRunner = () => ({ status: 0, stdout: 'created', stderr: '' });
    expect(createSbProject({ prefix: 'X', name: 'Demo', run: runBare }).projectId).toBeUndefined();
  });
  it('fails closed on non-zero exit', () => {
    const run: SbRunner = () => ({ status: 1, stdout: '', stderr: 'nope' });
    expect(linkSbProject({ run }).ok).toBe(false);
    expect(createSbProject({ prefix: 'X', name: 'Demo', run }).ok).toBe(false);
  });
});

// NOTE (amended A8/A9 contract): import activation is owned by xtrm-6qu.9.
// A8 never invokes `sb import beads`. Verified flag/envelope knowledge for
// the A9 implementer: always pass --json (the envelope holds only with it;
// without --json sb prints bare human JSON by design).

describe('parseCreateProjectFlag (--sb-create-project PREFIX:Name)', () => {
  it('parses prefix and name on the first colon', () => {
    expect(parseCreateProjectFlag('X:Demo')).toEqual({ prefix: 'X', name: 'Demo' });
    expect(parseCreateProjectFlag('X:Demo:More')).toEqual({ prefix: 'X', name: 'Demo:More' });
  });

  it('rejects missing colon, empty parts, and spaced prefixes', () => {
    expect(parseCreateProjectFlag('no-colon')).toBeNull();
    expect(parseCreateProjectFlag(':Name')).toBeNull();
    expect(parseCreateProjectFlag('X:')).toBeNull();
    expect(parseCreateProjectFlag('X Y:Name')).toBeNull();
    expect(parseCreateProjectFlag('')).toBeNull();
  });
});

describe('executePlanCommands (verbatim argv, abort, bounded output)', () => {
  it('runs in order and aborts on the first nonzero exit', async () => {
    const { executePlanCommands } = await import('../core/substrate.js');
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes('second')) return { status: 1, stdout: 'out2\n'.repeat(30), stderr: 'boom', error: undefined };
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const info = executePlanCommands(
      [
        { label: 'first', cmd: 'echo', args: ['first'] },
        { label: 'second', cmd: 'echo', args: ['second'] },
        { label: 'third', cmd: 'echo', args: ['third'] },
      ],
      { run },
    );
    expect(info.ok).toBe(false);
    expect(info.failedLabel).toBe('second');
    expect(calls).toHaveLength(2);
    expect(info.results[1]?.stdout ?? '').toContain('truncated');
  });

  it('fails closed on malformed plan entries instead of throwing', async () => {
    const { executePlanCommands, validatePlanCommands } = await import('../core/substrate.js');
    expect(validatePlanCommands([{ label: 'bad', cmd: '', args: [] }])).toMatch(/malformed/);
    expect(validatePlanCommands([{ label: 'ok', cmd: 'true', args: [] }])).toBeNull();
    expect(validatePlanCommands([{ label: '   ', cmd: 'true', args: [] }])).toMatch(/malformed/);
    expect(validatePlanCommands([{ label: 'ok', cmd: '   ', args: [] }])).toMatch(/malformed/);
    expect(validatePlanCommands([{ label: '', cmd: 'true', args: [] }])).toMatch(/malformed/);
    const info = executePlanCommands([{ label: 'bad', cmd: '', args: [] }], { run: () => { throw new Error('must not run'); } });
    expect(info.ok).toBe(false);
    expect(info.failedLabel).toBe('(plan validation)');
  });

  it('validates the whole plan before executing command 1 (no partial mutation)', async () => {
    const { executePlanCommands } = await import('../core/substrate.js');
    const calls: string[][] = [];
    const info = executePlanCommands(
      [
        { label: 'first', cmd: 'echo', args: ['first'] },
        { label: 'bad', cmd: '', args: [] },
        { label: 'third', cmd: 'echo', args: ['third'] },
      ],
      { run: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; } },
    );
    expect(info.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

const FULL_ENROLLMENT = [
  { name: 'sb-enrolled', ok: true },
  { name: 'pi-enrolled', ok: true },
  { name: 'claude-marketplace-enrolled', ok: true },
  { name: 'claude-plugin-enrolled', ok: true },
  { name: 'claude-strict-live', ok: true },
  { name: 'beads-absent', ok: true },
];

describe('setup.ts integration contract (#168 source checks, #174 enrollment)', () => {
  const report = { ok: true, claude: [{ name: 'plugin-manifest', ok: true }], pi: [{ name: 'pi-extension', ok: true }], naming: { substratePlugins: [], beadsRemnants: ['beads'], duplicates: false }, enrollment: FULL_ENROLLMENT };

  it('resolves the XTRM_SUBSTRATE_SETUP override', () => {
    process.env.XTRM_SUBSTRATE_SETUP = '/tmp/fake-setup.ts';
    expect(resolveSetupTs()).toBe('/tmp/fake-setup.ts');
    delete process.env.XTRM_SUBSTRATE_SETUP;
  });

  it('fails closed on XTRM_SUBSTRATE_DIR without setup.ts despite a valid override', () => {
    process.env.XTRM_SUBSTRATE_DIR = path.join(tmpDir, 'no-such-dir');
    process.env.XTRM_SUBSTRATE_SETUP = '/tmp/fake-setup.ts';
    try {
      expect(resolveSetupTs()).toBeUndefined();
    } finally {
      delete process.env.XTRM_SUBSTRATE_DIR;
      delete process.env.XTRM_SUBSTRATE_SETUP;
    }
  });

  it('prefers XTRM_SUBSTRATE_DIR over a conflicting XTRM_SUBSTRATE_SETUP', async () => {
    const dir = path.join(tmpDir, 'sdir');
    await fs.ensureDir(path.join(dir, 'integrations'));
    await fs.writeFile(path.join(dir, 'integrations', 'setup.ts'), '// stub');
    process.env.XTRM_SUBSTRATE_DIR = dir;
    process.env.XTRM_SUBSTRATE_SETUP = '/tmp/fake-setup.ts';
    try {
      expect(resolveSetupTs()).toBe(path.join(dir, 'integrations', 'setup.ts'));
    } finally {
      delete process.env.XTRM_SUBSTRATE_DIR;
      delete process.env.XTRM_SUBSTRATE_SETUP;
    }
  });

  it('interprets check reports and surfaces remnants', async () => {
    const script = path.join(tmpDir, 'setup-check.cjs');
    await fs.writeFile(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`);
    await fs.chmod(script, 0o755);
    const info = runSetupCheck({ setupTs: script });
    expect(info.ok).toBe(true);
    expect(info.report?.naming.beadsRemnants).toEqual(['beads']);
  });

  it('interprets plan surfaces with canonical dir and commands', async () => {
    const plan = { surfaces: [{ surface: 'claude-plugin', source: 's', target: 't', steps: ['a'] }], dir: '/tmp/sub', commands: [{ label: 'noop', cmd: 'true', args: [] }] };
    const script = path.join(tmpDir, 'setup-plan.cjs');
    await fs.writeFile(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(plan))});\n`);
    await fs.chmod(script, 0o755);
    const info = runSetupPlan({ setupTs: script });
    expect(info.ok).toBe(true);
    expect(info.surfaces).toHaveLength(1);
    expect(info.dir).toBe('/tmp/sub');
    expect(info.commands).toHaveLength(1);
  });

  it('rejects plans without a canonical dir or with zero commands', async () => {
    for (const plan of [
      { surfaces: [], dir: null, commands: [{ label: 'x', cmd: 'true', args: [] }] },
      { surfaces: [], dir: '/tmp/sub', commands: [] },
      { surfaces: [] },
    ]) {
      const script = path.join(tmpDir, `setup-plan-bad-${Math.random().toString(36).slice(2)}.cjs`);
      await fs.writeFile(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(plan))});\n`);
      await fs.chmod(script, 0o755);
      expect(runSetupPlan({ setupTs: script }).ok).toBe(false);
    }
  });

  it('fails closed without setup.ts and on bad JSON', () => {
    delete process.env.XTRM_SUBSTRATE_SETUP;
    expect(runSetupCheck({ setupTs: path.join(tmpDir, 'missing.cjs') }).ok).toBe(false);
  });

  it('fails when any enrollment item is not ok', async () => {
    const enrollment = FULL_ENROLLMENT.map(e => e.name === 'pi-enrolled' ? { ...e, ok: false } : e);
    const report = { ok: true, claude: [], pi: [], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false }, enrollment };
    const script = path.join(tmpDir, 'setup-enroll-fail.cjs');
    await fs.writeFile(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`);
    await fs.chmod(script, 0o755);
    const info = runSetupCheck({ setupTs: script });
    expect(info.ok).toBe(false);
    expect(info.error).toContain('pi-enrolled');
  });
  it('rejects enrollment with missing array, duplicates, extras, or gaps', async () => {
    const base = { ok: true, claude: [], pi: [], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false } };
    const variants: Array<[string, unknown]> = [
      ['no-enrollment', base],
      ['duplicate', { ...base, enrollment: [...FULL_ENROLLMENT, FULL_ENROLLMENT[0]] }],
      ['extra', { ...base, enrollment: [...FULL_ENROLLMENT, { name: 'mystery-item', ok: true }] }],
      ['gap', { ...base, enrollment: FULL_ENROLLMENT.slice(1) }],
    ];
    for (const [tag, report] of variants) {
      const script = path.join(tmpDir, `setup-enroll-${tag}.cjs`);
      await fs.writeFile(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`);
      await fs.chmod(script, 0o755);
      expect(runSetupCheck({ setupTs: script }).ok, tag).toBe(false);
    }
  });
});

describe('project link state (via doctor data.link; no list verb exists)', () => {
  it('resolves the linked project from a healthy envelope', () => {
    const info = getSbProjectLink(undefined, stubRunner({ doctor: { status: 0, stdout: JSON.stringify(healthyDoctorEnvelope) } }));
    expect(info.ok).toBe(true);
    expect(info.projectId).toBe('XTRM-1');
    expect(info.source).toBe('env');
  });

  it('reports unlinked checkouts without inventing identity', () => {
    const noLink = { schema: 'substrate-cli/v1', command: 'doctor', ok: true, data: { dbPath: 'x', schemaHealthy: true, link: null, linkError: 'none' } };
    const info = getSbProjectLink(undefined, stubRunner({ doctor: { status: 0, stdout: JSON.stringify(noLink) } }));
    expect(info.ok).toBe(false);
    expect(info.projectId).toBeNull();
  });
});

describe('state.db presence (ADR-grounded default path)', () => {
  it('defaults under ~/.xtrm and reports presence honestly', async () => {
    const home = path.join(tmpDir, 'home');
    expect(defaultStateDbPath(home)).toBe(path.join(home, '.xtrm', 'state.db'));
    expect(stateDbPresent(path.join(home, '.xtrm', 'state.db'))).toBe(false);
    await fs.ensureDir(path.join(home, '.xtrm'));
    await fs.writeFile(path.join(home, '.xtrm', 'state.db'), 'x');
    expect(stateDbPresent(path.join(home, '.xtrm', 'state.db'))).toBe(true);
  });
});
