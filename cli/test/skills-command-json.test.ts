import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(__dirname, '../dist/index.cjs');

function run(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [CLI_BIN, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createSkill(skillRoot: string, skillName: string): void {
  const dir = path.join(skillRoot, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${skillName}\n`, 'utf8');
}

function createPack(packRoot: string, packName: string, skills: readonly string[], includeMetadata = true): void {
  const dir = path.join(packRoot, packName);
  fs.mkdirSync(dir, { recursive: true });
  if (includeMetadata) {
    writeJson(path.join(dir, 'PACK.json'), {
      schemaVersion: '1',
      name: packName,
      version: '1.0.0',
      description: `${packName} pack`,
      skills,
    });
  }

  for (const skill of skills) {
    createSkill(dir, skill);
  }
}

describe('xt skills JSON CLI integration', () => {
  let tmpHome = '';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-skills-json-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('lists runtime state and pack enablement in --json output', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    createPack(path.join(skillsRoot, 'optional'), 'opt-pack', ['opt-skill']);
    createPack(skillsRoot, 'user-pack', ['user-skill'], false);

    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: ['opt-pack'],
        pi: ['user-pack'],
      },
    });

    const result = run(['skills', 'list', '--global', '--json'], { env: { HOME: tmpHome } });
    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      runtimes: string[];
      defaultSkills: string[];
      packs: Array<{ name: string; enabledIn: string[] }>;
      runtimeStatus: Array<{ runtime: string; enabledPacks: string[]; activeSkills: string[] }>;
    };

    expect(payload.runtimes).toEqual(['claude', 'pi', 'codex']);
    expect(payload.defaultSkills).toEqual(['always-on']);
    expect(payload.packs.map(pack => pack.name)).toEqual(['opt-pack', 'user-pack']);

    const optionalPack = payload.packs.find(pack => pack.name === 'opt-pack');
    const userPack = payload.packs.find(pack => pack.name === 'user-pack');
    expect(optionalPack?.enabledIn).toEqual(['claude']);
    expect(userPack?.enabledIn).toEqual(['pi']);

    const claudeRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'claude');
    const piRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'pi');
    const codexRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'codex');

    expect(claudeRuntime?.enabledPacks).toEqual(['opt-pack']);
    expect(claudeRuntime?.activeSkills).toEqual(['always-on', 'opt-skill']);
    expect(piRuntime?.enabledPacks).toEqual(['user-pack']);
    expect(piRuntime?.activeSkills).toEqual(['always-on', 'user-skill']);
    expect(codexRuntime?.enabledPacks).toEqual([]);
    expect(codexRuntime?.activeSkills).toEqual(['always-on']);
  });

  it('enables a pack for all runtimes by default and supports a Pi-only disable', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    createPack(path.join(skillsRoot, 'optional'), 'alpha-pack', ['alpha-skill']);

    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: [],
        pi: [],
      },
    });

    const enable = run(['skills', 'enable', 'alpha-pack', '--global', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(enable.status).toBe(0);

    const afterEnable = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'state.json'), 'utf8')) as {
      enabledPacks: { claude: string[]; pi: string[]; codex: string[] };
    };
    expect(afterEnable.enabledPacks.claude).toEqual(['alpha-pack']);
    expect(afterEnable.enabledPacks.pi).toEqual(['alpha-pack']);
    expect(afterEnable.enabledPacks.codex).toEqual(['alpha-pack']);

    const globalView = (runtime: string): string => path.join(skillsRoot, 'active', runtime);
    expect(fs.existsSync(path.join(globalView('claude'), 'alpha-skill'))).toBe(true);
    expect(fs.existsSync(path.join(globalView('pi'), 'alpha-skill'))).toBe(true);
    expect(fs.existsSync(path.join(globalView('codex'), 'alpha-skill'))).toBe(true);

    const disablePiOnly = run(['skills', 'disable', 'alpha-pack', '--global', '--pi', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(disablePiOnly.status).toBe(0);

    const afterDisablePiOnly = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'state.json'), 'utf8')) as {
      enabledPacks: { claude: string[]; pi: string[]; codex: string[] };
    };
    expect(afterDisablePiOnly.enabledPacks.claude).toEqual(['alpha-pack']);
    expect(afterDisablePiOnly.enabledPacks.pi).toEqual([]);
    expect(afterDisablePiOnly.enabledPacks.codex).toEqual(['alpha-pack']);

    // Per-runtime views must diverge: Pi drops the pack, Claude/Codex keep it.
    expect(fs.existsSync(path.join(globalView('pi'), 'alpha-skill'))).toBe(false);
    expect(fs.existsSync(path.join(globalView('claude'), 'alpha-skill'))).toBe(true);
    expect(fs.existsSync(path.join(globalView('codex'), 'alpha-skill'))).toBe(true);
    expect(fs.existsSync(path.join(globalView('pi'), 'always-on', 'SKILL.md'))).toBe(true);
  });

  it('disable all clears all runtimes atomically', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    createPack(path.join(skillsRoot, 'optional'), 'alpha-pack', ['alpha-skill']);
    createPack(path.join(skillsRoot, 'optional'), 'beta-pack', ['beta-skill']);

    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: ['alpha-pack'],
        pi: ['beta-pack'],
      },
    });

    run(['skills', 'enable', 'beta-pack', '--global', '--claude', '--json'], {
      env: { HOME: tmpHome },
    });

    const disableAll = run(['skills', 'disable', 'all', '--global', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(disableAll.status).toBe(0);

    const payload = JSON.parse(disableAll.stdout) as {
      resolvedPacks: string[];
      runtimes: string[];
      state: { enabledPacks: { claude: string[]; pi: string[]; codex: string[] } };
    };
    expect(payload.resolvedPacks).toEqual(['alpha-pack', 'beta-pack']);
    expect(payload.runtimes).toEqual(['claude', 'pi', 'codex']);
    expect(payload.state.enabledPacks).toEqual({ claude: [], pi: [], codex: [] });

    const persistedState = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'state.json'), 'utf8')) as {
      enabledPacks: { claude: string[]; pi: string[]; codex: string[] };
    };
    expect(persistedState.enabledPacks).toEqual({ claude: [], pi: [], codex: [] });

    for (const runtime of ['claude', 'pi', 'codex']) {
      const viewRoot = path.join(skillsRoot, 'active', runtime);
      expect(fs.existsSync(path.join(viewRoot, 'always-on', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(viewRoot, 'alpha-skill'))).toBe(false);
      expect(fs.existsSync(path.join(viewRoot, 'beta-skill'))).toBe(false);
    }
  });

  it('uses filesystem-authoritative skills from flat packs during enable', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: [],
        pi: [],
      },
    });

    const packDir = path.join(skillsRoot, 'mypack');
    fs.mkdirSync(packDir, { recursive: true });
    createSkill(packDir, 'demo-skill');

    const enable = run(['skills', 'enable', 'mypack', '--global', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(enable.status).toBe(0);

    const enablePayload = JSON.parse(enable.stdout) as { resolvedPacks: string[] };
    expect(enablePayload.resolvedPacks).toEqual(['mypack']);

    const state = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'state.json'), 'utf8')) as {
      enabledPacks: { claude: string[]; pi: string[]; codex: string[] };
    };
    expect(state.enabledPacks.claude).toEqual(['mypack']);
    expect(state.enabledPacks.pi).toEqual(['mypack']);
    expect(state.enabledPacks.codex).toEqual(['mypack']);
  });

  it('ignores retired PACK.json metadata in flat packs', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: [],
        pi: [],
      },
    });

    const packDir = path.join(skillsRoot, 'drift-pack');
    fs.mkdirSync(packDir, { recursive: true });
    writeJson(path.join(packDir, 'PACK.json'), {
      schemaVersion: '1',
      name: 'drift-pack',
      version: '1.0.0',
      description: 'drift-pack',
      skills: ['metadata-only'],
    });
    createSkill(packDir, 'filesystem-only');

    const listed = run(['skills', 'list', '--global', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(listed.status).toBe(0);

    const payload = JSON.parse(listed.stdout) as {
      warnings: string[];
      packs: Array<{ name: string; skills: string[] }>;
    };

    expect(payload.warnings).toEqual([]);
    expect(payload.packs.find(candidate => candidate.name === 'drift-pack')?.skills).toEqual(['filesystem-only']);
  });

  it('supports create-pack + runtime-targeted enable with real pack data', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: [],
        pi: [],
      },
    });

    const created = run(['skills', 'create-pack', 'new-pack', '--global', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(created.status).toBe(0);

    const packDir = path.join(skillsRoot, 'new-pack');
    expect(fs.existsSync(packDir)).toBe(true);
    createSkill(packDir, 'new-pack-skill');

    const enableClaudeOnly = run(['skills', 'enable', 'new-pack', '--global', '--claude', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(enableClaudeOnly.status).toBe(0);

    const listed = run(['skills', 'list', '--global', '--json'], { env: { HOME: tmpHome } });
    expect(listed.status).toBe(0);

    const payload = JSON.parse(listed.stdout) as {
      runtimeStatus: Array<{ runtime: string; enabledPacks: string[]; activeSkills: string[] }>;
    };

    const claudeRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'claude');
    const piRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'pi');
    const codexRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'codex');

    expect(claudeRuntime?.enabledPacks).toEqual(['new-pack']);
    expect(claudeRuntime?.activeSkills).toContain('new-pack-skill');
    expect(piRuntime?.enabledPacks).toEqual([]);
    expect(piRuntime?.activeSkills).not.toContain('new-pack-skill');
    expect(codexRuntime?.enabledPacks).toEqual([]);
    expect(codexRuntime?.activeSkills).not.toContain('new-pack-skill');
  });

  it('defaults to --global for list and --local for create-pack when no scope flag is provided', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-skills-local-'));

    try {
      fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

      const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');
      createSkill(path.join(projectSkillsRoot, 'default'), 'project-default');
      writeJson(path.join(projectSkillsRoot, 'state.json'), {
        schemaVersion: '1',
        enabledPacks: {
          claude: ['project-pack'],
          pi: [],
        },
      });
      createPack(path.join(projectSkillsRoot, 'optional'), 'project-pack', ['project-skill']);

      const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
      createSkill(path.join(homeSkillsRoot, 'default'), 'home-default');
      createPack(path.join(homeSkillsRoot, 'optional'), 'home-pack', ['home-skill']);
      writeJson(path.join(homeSkillsRoot, 'state.json'), {
        schemaVersion: '1',
        enabledPacks: {
          claude: ['home-pack'],
          pi: [],
        },
      });

      const listResult = run(['skills', 'list', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });
      expect(listResult.status).toBe(0);

      const listPayload = JSON.parse(listResult.stdout) as {
        scope: string;
        skillsRoot: string;
        defaultSkills: string[];
        packs: Array<{ name: string; source?: string }>;
      };

      expect(listPayload.scope).toBe('global');
      expect(listPayload.skillsRoot).toBe(homeSkillsRoot);
      expect(listPayload.defaultSkills).toEqual(['home-default']);

      const listLocalResult = run(['skills', 'list', '--local', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });
      expect(listLocalResult.status).toBe(0);
      const listLocalPayload = JSON.parse(listLocalResult.stdout) as {
        scope: string;
        skillsRoot: string;
        defaultSkills: string[];
        packs: Array<{ name: string; source?: string }>;
      };
      expect(listLocalPayload.scope).toBe('local');
      expect(listLocalPayload.skillsRoot).toBe(projectSkillsRoot);
      expect(listLocalPayload.defaultSkills).toEqual(['project-default']);

      const createPackResult = run(['skills', 'create-pack', 'local-pack', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });
      expect(createPackResult.status).toBe(0);
      expect(fs.existsSync(path.join(projectSkillsRoot, 'local-pack'))).toBe(true);
      expect(fs.existsSync(path.join(homeSkillsRoot, 'local-pack'))).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('enables a globally-shipped pack with --local when the repo has no optional dir', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-skills-shipped-pack-'));

    try {
      fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

      const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
      createSkill(path.join(homeSkillsRoot, 'default'), 'always-on');
      createPack(path.join(homeSkillsRoot, 'optional'), 'shipped-pack', ['shipped-skill']);
      writeJson(path.join(homeSkillsRoot, 'state.json'), {
        schemaVersion: '2',
        enabledPacks: { claude: [], pi: [], codex: [] },
        managedLinks: { claude: {}, pi: {}, codex: {} },
      });

      const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');
      writeJson(path.join(projectSkillsRoot, 'state.json'), {
        schemaVersion: '2',
        enabledPacks: { claude: [], pi: [], codex: [] },
        managedLinks: { claude: {}, pi: {}, codex: {} },
      });

      const enabled = run(['skills', 'enable', 'shipped-pack', '--local', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });
      expect(enabled.status).toBe(0);

      // The repo never grows an optional/ dir; the payload comes from global scope.
      expect(fs.existsSync(path.join(projectSkillsRoot, 'optional'))).toBe(false);

      for (const runtimeDir of ['.claude/skills', '.pi/skills', '.agents/skills']) {
        const linkPath = path.join(projectRoot, runtimeDir, 'shipped-skill');
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(linkPath)).toBe(
          fs.realpathSync(path.join(homeSkillsRoot, 'optional', 'shipped-pack', 'shipped-skill')),
        );
      }

      const state = JSON.parse(fs.readFileSync(path.join(projectSkillsRoot, 'state.json'), 'utf8')) as {
        enabledPacks: Record<string, string[]>;
      };
      expect(state.enabledPacks.claude).toEqual(['shipped-pack']);
      expect(state.enabledPacks.pi).toEqual(['shipped-pack']);
      expect(state.enabledPacks.codex).toEqual(['shipped-pack']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('leaves local state unchanged when activation fails', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-skills-fail-atomic-'));

    try {
      fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

      const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
      createSkill(path.join(homeSkillsRoot, 'default'), 'always-on');
      writeJson(path.join(homeSkillsRoot, 'state.json'), {
        schemaVersion: '2',
        enabledPacks: { claude: [], pi: [], codex: [] },
        managedLinks: { claude: {}, pi: {}, codex: {} },
      });

      const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');
      createPack(projectSkillsRoot, 'collide-pack', ['always-on']);
      const statePath = path.join(projectSkillsRoot, 'state.json');
      writeJson(statePath, {
        schemaVersion: '2',
        enabledPacks: { claude: [], pi: [], codex: [] },
        managedLinks: { claude: {}, pi: {}, codex: {} },
      });
      const before = fs.readFileSync(statePath, 'utf8');

      const enabled = run(['skills', 'enable', 'collide-pack', '--local', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });

      expect(enabled.status).toBe(1);
      expect(enabled.stderr).toMatch(/collides with global default/i);
      expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'always-on'))).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('disable --local on globally-enabled pack gives helpful error', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-skills-disable-local-'));

    try {
      fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

      const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
      createPack(path.join(homeSkillsRoot, 'optional'), 'global-pack', ['global-skill']);
      writeJson(path.join(homeSkillsRoot, 'state.json'), {
        schemaVersion: '1',
        enabledPacks: {
          claude: ['global-pack'],
          pi: ['global-pack'],
        },
      });

      const result = run(['skills', 'disable', 'global-pack', '--local', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Pack "global-pack" is globally enabled');
      expect(result.stderr).toContain('use --global to disable everywhere, or leave alone and add a local override');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('materializes user-scope runtime views on global enable and adopts legacy pointers', () => {
    const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(homeSkillsRoot, 'default'), 'always-on');
    createPack(path.join(homeSkillsRoot, 'optional'), 'shipped-pack', ['shipped-skill']);
    const statePath = path.join(homeSkillsRoot, 'state.json');
    writeJson(statePath, {
      schemaVersion: '2',
      enabledPacks: { claude: [], pi: [], codex: [] },
      managedLinks: { claude: {}, pi: {}, codex: {} },
    });

    // Legacy install: user-scope pointers aimed straight at the default tier.
    const legacyTarget = path.join(homeSkillsRoot, 'default');
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.pi', 'agent'), { recursive: true });
    fs.symlinkSync(legacyTarget, path.join(tmpHome, '.claude', 'skills'));
    fs.symlinkSync(legacyTarget, path.join(tmpHome, '.pi', 'agent', 'skills'));

    const enabled = run(['skills', 'enable', 'shipped-pack', '--global', '--json'], { env: { HOME: tmpHome } });
    expect(enabled.status).toBe(0);

    for (const [runtime, pointer] of [
      ['claude', path.join(tmpHome, '.claude', 'skills')],
      ['pi', path.join(tmpHome, '.pi', 'agent', 'skills')],
      ['codex', path.join(tmpHome, '.agents', 'skills')],
    ] as const) {
      expect(fs.readlinkSync(pointer)).toBe(path.join(homeSkillsRoot, 'active', runtime));
      expect(fs.existsSync(path.join(pointer, 'always-on', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(pointer, 'shipped-skill', 'SKILL.md'))).toBe(true);
    }

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { enabledPacks: Record<string, string[]> };
    expect(state.enabledPacks.claude).toEqual(['shipped-pack']);
    expect(state.enabledPacks.pi).toEqual(['shipped-pack']);
    expect(state.enabledPacks.codex).toEqual(['shipped-pack']);
  });

  it('removes only the disabled pack from global views', () => {
    const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(homeSkillsRoot, 'default'), 'always-on');
    createPack(path.join(homeSkillsRoot, 'optional'), 'shipped-pack', ['shipped-skill']);
    const statePath = path.join(homeSkillsRoot, 'state.json');
    writeJson(statePath, {
      schemaVersion: '2',
      enabledPacks: { claude: [], pi: [], codex: [] },
      managedLinks: { claude: {}, pi: {}, codex: {} },
    });

    expect(run(['skills', 'enable', 'shipped-pack', '--global', '--json'], { env: { HOME: tmpHome } }).status).toBe(0);
    const viewRoot = path.join(homeSkillsRoot, 'active', 'claude');
    expect(fs.existsSync(path.join(viewRoot, 'shipped-skill'))).toBe(true);

    const disabled = run(['skills', 'disable', 'shipped-pack', '--global', '--json'], { env: { HOME: tmpHome } });
    expect(disabled.status).toBe(0);
    expect(fs.existsSync(path.join(viewRoot, 'shipped-skill'))).toBe(false);
    expect(fs.existsSync(path.join(viewRoot, 'always-on', 'SKILL.md'))).toBe(true);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { enabledPacks: Record<string, string[]> };
    expect(state.enabledPacks.claude).toEqual([]);
    expect(state.enabledPacks.pi).toEqual([]);
    expect(state.enabledPacks.codex).toEqual([]);
  });

  it('leaves global state unchanged when view activation fails', () => {
    const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(homeSkillsRoot, 'default'), 'always-on');
    createPack(path.join(homeSkillsRoot, 'optional'), 'shipped-pack', ['shipped-skill']);
    const statePath = path.join(homeSkillsRoot, 'state.json');
    writeJson(statePath, {
      schemaVersion: '2',
      enabledPacks: { claude: [], pi: [], codex: [] },
      managedLinks: { claude: {}, pi: {}, codex: {} },
    });
    const before = fs.readFileSync(statePath, 'utf8');

    // Foreign real directory at the user-scope entry point must fail closed.
    fs.mkdirSync(path.join(tmpHome, '.claude', 'skills'), { recursive: true });

    const enabled = run(['skills', 'enable', 'shipped-pack', '--global', '--json'], { env: { HOME: tmpHome } });
    expect(enabled.status).toBe(1);
    expect(enabled.stderr).toMatch(/Refusing to replace existing ~\/\.claude\/skills/);
    expect(fs.readFileSync(statePath, 'utf8')).toBe(before);
  });
});
