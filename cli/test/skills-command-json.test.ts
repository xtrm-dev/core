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

function createPack(packRoot: string, packName: string, skills: readonly string[]): void {
  const dir = path.join(packRoot, packName);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'PACK.json'), {
    schemaVersion: '1',
    name: packName,
    version: '1.0.0',
    description: `${packName} pack`,
    skills,
  });

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
    createPack(path.join(skillsRoot, 'user', 'packs'), 'user-pack', ['user-skill']);

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

    expect(payload.runtimes).toEqual(['claude', 'pi']);
    expect(payload.defaultSkills).toEqual(['always-on']);
    expect(payload.packs.map(pack => pack.name)).toEqual(['opt-pack', 'user-pack']);

    const optionalPack = payload.packs.find(pack => pack.name === 'opt-pack');
    const userPack = payload.packs.find(pack => pack.name === 'user-pack');
    expect(optionalPack?.enabledIn).toEqual(['claude']);
    expect(userPack?.enabledIn).toEqual(['pi']);

    const claudeRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'claude');
    const piRuntime = payload.runtimeStatus.find(runtime => runtime.runtime === 'pi');

    expect(claudeRuntime?.enabledPacks).toEqual(['opt-pack']);
    expect(claudeRuntime?.activeSkills).toEqual(['always-on', 'opt-skill']);
    expect(piRuntime?.enabledPacks).toEqual(['user-pack']);
    expect(piRuntime?.activeSkills).toEqual(['always-on', 'user-skill']);
  });

  it('enables pack for both runtimes by default and mutates active views correctly', () => {
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
      enabledPacks: { claude: string[]; pi: string[] };
    };
    expect(afterEnable.enabledPacks.claude).toEqual(['alpha-pack']);
    expect(afterEnable.enabledPacks.pi).toEqual(['alpha-pack']);

    const activeAfterEnable = fs.readdirSync(path.join(skillsRoot, 'active')).sort();
    expect(activeAfterEnable).toEqual(['alpha-skill', 'always-on']);

    const disablePiOnly = run(['skills', 'disable', 'alpha-pack', '--global', '--pi', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(disablePiOnly.status).toBe(0);

    const afterDisablePiOnly = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'state.json'), 'utf8')) as {
      enabledPacks: { claude: string[]; pi: string[] };
    };
    expect(afterDisablePiOnly.enabledPacks.claude).toEqual(['alpha-pack']);
    expect(afterDisablePiOnly.enabledPacks.pi).toEqual([]);

    const activeAfterDisable = fs.readdirSync(path.join(skillsRoot, 'active')).sort();
    expect(activeAfterDisable).toEqual(['always-on']);
  });

  it('disable all clears both runtimes atomically', () => {
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
      state: { enabledPacks: { claude: string[]; pi: string[] } };
    };
    expect(payload.resolvedPacks).toEqual(['alpha-pack', 'beta-pack']);
    expect(payload.runtimes).toEqual(['claude', 'pi']);
    expect(payload.state.enabledPacks).toEqual({ claude: [], pi: [] });

    const persistedState = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'state.json'), 'utf8')) as {
      enabledPacks: { claude: string[]; pi: string[] };
    };
    expect(persistedState.enabledPacks).toEqual({ claude: [], pi: [] });

    expect(fs.readdirSync(path.join(skillsRoot, 'active')).sort()).toEqual(['always-on']);
  });

  it('syncs PACK.json skills from filesystem during enable when metadata is stale', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: [],
        pi: [],
      },
    });

    const packDir = path.join(skillsRoot, 'user', 'packs', 'mypack');
    fs.mkdirSync(packDir, { recursive: true });
    writeJson(path.join(packDir, 'PACK.json'), {
      schemaVersion: '1',
      name: 'mypack',
      version: '1.0.0',
      description: 'mypack',
      skills: [],
    });
    createSkill(packDir, 'demo-skill');

    const enable = run(['skills', 'enable', 'mypack', '--global', '--json'], {
      env: { HOME: tmpHome },
    });
    expect(enable.status).toBe(0);

    const enablePayload = JSON.parse(enable.stdout) as { syncedPacks: string[] };
    expect(enablePayload.syncedPacks).toEqual(['mypack']);

    const metadata = JSON.parse(fs.readFileSync(path.join(packDir, 'PACK.json'), 'utf8')) as {
      skills: string[];
    };
    expect(metadata.skills).toEqual(['demo-skill']);

    const state = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'state.json'), 'utf8')) as {
      enabledPacks: { claude: string[]; pi: string[] };
    };
    expect(state.enabledPacks.claude).toEqual(['mypack']);
    expect(state.enabledPacks.pi).toEqual(['mypack']);
  });

  it('auto-syncs stale PACK.json on list and reports warnings without failing', () => {
    const skillsRoot = path.join(tmpHome, '.xtrm', 'skills');
    createSkill(path.join(skillsRoot, 'default'), 'always-on');
    writeJson(path.join(skillsRoot, 'state.json'), {
      schemaVersion: '1',
      enabledPacks: {
        claude: [],
        pi: [],
      },
    });

    const packDir = path.join(skillsRoot, 'optional', 'drift-pack');
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
      syncedPacks: string[];
      warnings: string[];
      packs: Array<{ name: string; metadataMismatch: { metadataOnlySkills: string[]; filesystemOnlySkills: string[] } }>;
    };

    expect(payload.syncedPacks).toEqual(['drift-pack']);
    expect(payload.warnings.some(warning => warning.includes("Auto-synced PACK.json skills from filesystem for 'drift-pack'."))).toBe(true);

    const pack = payload.packs.find(candidate => candidate.name === 'drift-pack');
    expect(pack?.metadataMismatch).toEqual({
      metadataOnlySkills: [],
      filesystemOnlySkills: [],
    });

    const metadata = JSON.parse(fs.readFileSync(path.join(packDir, 'PACK.json'), 'utf8')) as {
      skills: string[];
    };
    expect(metadata.skills).toEqual(['filesystem-only']);
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

    const packDir = path.join(skillsRoot, 'user', 'packs', 'new-pack');
    const metadataPath = path.join(packDir, 'PACK.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      schemaVersion: string;
      name: string;
      skills: string[];
    };

    expect(metadata.schemaVersion).toBe('1');
    expect(metadata.name).toBe('new-pack');

    createSkill(packDir, 'new-pack-skill');
    writeJson(metadataPath, {
      ...metadata,
      skills: ['new-pack-skill'],
    });

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

    expect(claudeRuntime?.enabledPacks).toEqual(['new-pack']);
    expect(claudeRuntime?.activeSkills).toContain('new-pack-skill');
    expect(piRuntime?.enabledPacks).toEqual([]);
    expect(piRuntime?.activeSkills).not.toContain('new-pack-skill');
  });

  it('uses project-local scope by default when no scope flag is provided', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-skills-local-'));

    try {
      fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

      const projectSkillsRoot = path.join(projectRoot, '.xtrm', 'skills');
      createSkill(path.join(projectSkillsRoot, 'default'), 'project-default');
      writeJson(path.join(projectSkillsRoot, 'state.json'), {
        schemaVersion: '1',
        enabledPacks: {
          claude: [],
          pi: [],
        },
      });

      const homeSkillsRoot = path.join(tmpHome, '.xtrm', 'skills');
      createSkill(path.join(homeSkillsRoot, 'default'), 'home-default');
      writeJson(path.join(homeSkillsRoot, 'state.json'), {
        schemaVersion: '1',
        enabledPacks: {
          claude: [],
          pi: [],
        },
      });

      const listResult = run(['skills', 'list', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });
      expect(listResult.status).toBe(0);

      const listPayload = JSON.parse(listResult.stdout) as {
        skillsRoot: string;
        defaultSkills: string[];
      };

      expect(listPayload.skillsRoot).toBe(projectSkillsRoot);
      expect(listPayload.defaultSkills).toEqual(['project-default']);

      const createPackResult = run(['skills', 'create-pack', 'local-pack', '--json'], {
        cwd: projectRoot,
        env: { HOME: tmpHome },
      });
      expect(createPackResult.status).toBe(0);
      expect(fs.existsSync(path.join(projectSkillsRoot, 'user', 'packs', 'local-pack', 'PACK.json'))).toBe(true);
      expect(fs.existsSync(path.join(homeSkillsRoot, 'user', 'packs', 'local-pack', 'PACK.json'))).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
