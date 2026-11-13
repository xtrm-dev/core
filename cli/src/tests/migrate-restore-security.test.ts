// xtrm-zc1rs: security regression tests for `migrate --restore`.
//
// The pre-fix restoreBackup extracted an operator-supplied archive directly
// into .xtrm/ and only then checked for traversal. Crafted archives could
// write partial or wrong content into the destination (or plant symlinks,
// FIFOs, hard links) before rejection — and some were accepted outright.
//
// These tests craft archives by hand (no python dependency, no GNU-only
// features) and assert: rejected archive ⇒ exit 1, destination untouched,
// nothing written outside the restore root, existing target preserved.
// Valid xtrm-generated backups must still restore, including deep paths that
// force GNU long-name entries and executable permissions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'child_process';

const CLI_PATH = path.join(__dirname, '../../dist/index.cjs');

function runCli(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number | null } {
  try {
    // argv, not a shell string: every argument here is a test-supplied path,
    // so it must never reach a shell (CodeQL
    // js/shell-command-injection-from-environment, CORE-2694).
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const result = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { stdout: result, stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.status ?? 1,
    };
  }
}

// --- minimal tar builder (USTAR, GNU checksum, gzip wrapper) ---

interface TarEntrySpec {
  name?: string;
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo' | 'pax' | 'gnu-long';
  content?: string;
  linkname?: string;
  mode?: number;
  /** pax `path=` record applied to the next entry */
  paxPath?: string;
  /** GNU long-name data applied to the next entry */
  longName?: string;
}

function writeOctal(buf: Buffer, offset: number, value: number, digits: number): void {
  buf.write(value.toString(8).padStart(digits, '0'), offset, digits, 'ascii');
  buf[offset + digits] = 0;
}

function buildTarBuffer(entries: TarEntrySpec[]): Buffer {
  const chunks: Buffer[] = [];
  const typeChar: Record<string, string> = {
    file: '0', dir: '5', symlink: '2', hardlink: '1', fifo: '6', pax: 'x', 'gnu-long': 'L',
  };
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const placeholder =
      entry.type === 'gnu-long' ? '././@LongLink' : entry.type === 'pax' ? '././@PaxHeader' : '';
    header.write((entry.name ?? placeholder).slice(0, 100), 0, 'utf8');
    writeOctal(header, 100, entry.mode ?? (entry.type === 'dir' ? 0o755 : 0o644), 7);
    writeOctal(header, 108, 1000, 7);
    writeOctal(header, 116, 1000, 7);
    let data = Buffer.alloc(0);
    if (entry.type === 'file') data = Buffer.from(entry.content ?? '');
    if (entry.type === 'gnu-long') data = Buffer.from(`${entry.longName}\0`);
    if (entry.type === 'pax') {
      const record = `path=${entry.paxPath}\n`;
      const prefix = String(record.length + String(record.length).length);
      data = Buffer.from(`${prefix} ${record}`);
    }
    writeOctal(header, 124, data.length, 11);
    writeOctal(header, 136, 1700000000, 11);
    header[156] = typeChar[entry.type].charCodeAt(0);
    if (entry.linkname) header.write(entry.linkname.slice(0, 100), 157, 'utf8');
    header.write('ustar', 257, 'ascii');
    header.write('00', 263, 'ascii');
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header);
    if (data.length > 0) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function buildTgz(entries: TarEntrySpec[]): Buffer {
  return zlib.gzipSync(buildTarBuffer(entries));
}

// --- fixtures ---

let tmpHome: string;
let envCleanup: () => void;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-zc1rs-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  envCleanup = () => {
    process.env.HOME = originalHome;
    process.chdir(originalCwd);
  };
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  envCleanup();
  await fs.remove(tmpHome);
});

/** Minimal repo with an empty .xtrm — no skills/hooks content yet. */
async function createMinimalRepo(): Promise<string> {
  const repoDir = path.join(tmpHome, 'test-repo');
  await fs.ensureDir(path.join(repoDir, '.xtrm'));
  await fs.writeJson(path.join(repoDir, 'package.json'), { name: 'test-repo', version: '1.0.0' });
  return repoDir;
}

async function writeBackup(baseDir: string, filename: string, tgz: Buffer): Promise<string> {
  const p = path.join(baseDir, filename);
  await fs.writeFile(p, tgz);
  return p;
}

function restoreCmd(backupPath: string, repoDir: string, extra: string[] = []): { stdout: string; stderr: string; exitCode: number | null } {
  return runCli(['migrate', 'all', '--apply', '--restore', backupPath, '--repo', repoDir, ...extra], repoDir);
}

/** Recursive check that a dir tree contains exactly the given rel files+dirs. */
async function treeContainsOnly(dir: string, expected: string[]): Promise<boolean> {
  const found: string[] = [];
  const walk = async (cur: string) => {
    for (const e of await fs.readdir(cur, { withFileTypes: true })) {
      const rel = path.join(path.relative(dir, cur), e.name);
      found.push(rel);
      if (e.isDirectory()) await walk(path.join(cur, e.name));
    }
  };
  await walk(dir);
  const norm = found.map((f) => f.split(path.sep).join('/')).sort();
  return JSON.stringify(norm) === JSON.stringify([...expected].sort());
}

describe('migrate --restore archive security (xtrm-zc1rs)', () => {
  it('RED: parent-traversal archive is rejected and writes nothing before rejection', async () => {
    const repoDir = await createMinimalRepo();
    const escapePath = path.join(tmpHome, 'escaped.txt');
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: '../escaped.txt', type: 'file', content: 'PWNED' },
        { name: 'skills/', type: 'dir' },
        { name: 'skills/default/', type: 'dir' },
        { name: 'skills/default/ok.md', type: 'file', content: 'ok' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('traversal');
    // Pre-fix: tar extracted skills/default/ok.md into .xtrm before failing on
    // the ../ entry, so this assertion failed with the partial tree present.
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
    expect(await fs.pathExists(escapePath)).toBe(false);
  });

  it('RED: absolute-path archive is rejected with zero writes', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: `/tmp/${path.basename(tmpHome)}/abs-escaped.txt`, type: 'file', content: 'PWNED' },
        { name: 'skills/', type: 'dir' },
        { name: 'skills/default/', type: 'dir' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('absolute');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('RED: symlink-escape archive is rejected and leaves no symlink behind', async () => {
    const repoDir = await createMinimalRepo();
    const outsideDir = path.join(tmpHome, 'outside-dir');
    await fs.ensureDir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'sentinel.txt'), 'keep');
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: 'skills/', type: 'dir' },
        { name: 'skills/default', type: 'symlink', linkname: `../../../${path.basename(outsideDir)}` },
        { name: 'skills/default/pwned.md', type: 'file', content: 'PWNED' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('symbolic link');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
    expect(await fs.readFile(path.join(outsideDir, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('RED: hardlink-escape archive is rejected', async () => {
    const repoDir = await createMinimalRepo();
    const targetFile = path.join(tmpHome, 'target.txt');
    await fs.writeFile(targetFile, 'SECRET');
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: 'skills/', type: 'dir' },
        { name: 'skills/hard.md', type: 'hardlink', linkname: `../../../${path.basename(targetFile)}` },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('hard link');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('RED: FIFO special entry is rejected (pre-fix: accepted with exit 0)', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: 'skills/', type: 'dir' },
        { name: 'skills/default/', type: 'dir' },
        { name: 'skills/default/fifo.pipe', type: 'fifo' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('FIFO');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('pax-header path override is validated (no traversal via path= record)', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { type: 'pax', paxPath: '../../evil.txt' },
        { name: 'skills/default/ok.md', type: 'file', content: 'ok' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('traversal');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('GNU long-name entry carrying a traversal is rejected', async () => {
    const repoDir = await createMinimalRepo();
    const longName = `skills/default/${'a/'.repeat(40)}../../evil.txt`;
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { type: 'gnu-long', longName },
        { name: longName.slice(0, 100), type: 'file', content: 'PWNED' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('traversal');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('malformed archive (gzip of garbage) is rejected with zero writes', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      zlib.gzipSync(Buffer.from('this is not a tar archive at all')),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('truncated archive is rejected and leaves no partial tree', async () => {
    const repoDir = await createMinimalRepo();
    const full = buildTgz([
      { name: 'skills/', type: 'dir' },
      { name: 'skills/default/', type: 'dir' },
      { name: 'skills/default/cut.md', type: 'file', content: 'x'.repeat(400) },
    ]);
    // Cut the gzip stream mid-file: gunzip fails, nothing may be written.
    const backupPath = await writeBackup(tmpHome, 'skills-test-repo.tgz', full.subarray(0, Math.floor(full.length * 0.6)));

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('gzip-complete but tar-truncated archive is rejected', async () => {
    const repoDir = await createMinimalRepo();
    const tar = buildTarBuffer([
      { name: 'skills/', type: 'dir' },
      { name: 'skills/default/', type: 'dir' },
      { name: 'skills/default/cut.md', type: 'file', content: 'x'.repeat(400) },
    ]);
    // Valid gzip wrapping a tar whose file data is cut short.
    const backupPath = await writeBackup(tmpHome, 'skills-test-repo.tgz', zlib.gzipSync(tar.subarray(0, 1100)));

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('skills-named backup whose root is hooks/ is rejected (wrong component shape)', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: 'hooks/', type: 'dir' },
        { name: 'hooks/evil.mjs', type: 'file', content: 'x' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('skills');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm'))).toBe(true);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'hooks'))).toBe(false);
  });

  it('skills backup without default/ is rejected (unexpected layout)', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: 'skills/', type: 'dir' },
        { name: 'skills/optional/', type: 'dir' },
        { name: 'skills/optional/skill.md', type: 'file', content: 'x' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('default');
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('backup with an unrelated top-level root is rejected', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: 'skills/', type: 'dir' },
        { name: 'skills/default/', type: 'dir' },
        { name: 'evil/', type: 'dir' },
        { name: 'evil/x.txt', type: 'file', content: 'x' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills'))).toBe(false);
  });

  it('hooks-named backup with files at top level is rejected (no hooks/ root)', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'hooks-test-repo.tgz',
      buildTgz([
        { name: 'evil.mjs', type: 'file', content: 'x' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'hooks'))).toBe(false);
  });

  it('failed malicious restore with --force preserves the existing target', async () => {
    const repoDir = await createMinimalRepo();
    const precious = path.join(repoDir, '.xtrm', 'skills', 'default', 'precious.md');
    await fs.ensureDir(path.dirname(precious));
    await fs.writeFile(precious, 'precious content');
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: '../escaped.txt', type: 'file', content: 'PWNED' },
        { name: 'skills/', type: 'dir' },
        { name: 'skills/default/', type: 'dir' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir, ['--force']);

    expect(result.exitCode).toBe(1);
    expect(await fs.readFile(precious, 'utf8')).toBe('precious content');
    // No stray files added anywhere in .xtrm.
    expect(await treeContainsOnly(path.join(repoDir, '.xtrm'), ['skills', 'skills/default', 'skills/default/precious.md'])).toBe(true);
  });

  it('runtime-adoption backups remain non-restorable', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'adopt-runtime-test-repo.tgz',
      buildTgz([
        { name: 'default/', type: 'dir' },
        { name: 'default/skill.md', type: 'file', content: 'x' },
      ]),
    );

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('adopt-runtime');
  });

  it('dry-run on a malicious archive writes nothing', async () => {
    const repoDir = await createMinimalRepo();
    const backupPath = await writeBackup(
      tmpHome,
      'skills-test-repo.tgz',
      buildTgz([
        { name: '../escaped.txt', type: 'file', content: 'PWNED' },
      ]),
    );

    const result = runCli(['migrate', 'all', '--dry-run', '--restore', backupPath, '--repo', repoDir], repoDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('would extract');
    expect(await treeContainsOnly(path.join(repoDir, '.xtrm'), [])).toBe(true);
  });
});

// --- valid-backup behavior preserved (xtrm-generated archives) ---

describe('migrate --restore valid xtrm-generated backups (xtrm-zc1rs)', () => {
  async function seedSkillsRepo(): Promise<{ repoDir: string; backupDir: string }> {
    const repoDir = path.join(tmpHome, 'test-repo');
    await fs.ensureDir(path.join(repoDir, '.xtrm', 'skills', 'default'));
    await fs.ensureDir(path.join(repoDir, '.xtrm', 'skills', 'optional'));
    await fs.writeFile(path.join(repoDir, '.xtrm', 'skills', 'default', 'test-skill.md'), 'test skill content');
    await fs.writeFile(path.join(repoDir, '.xtrm', 'skills', 'optional', 'optional-skill.md'), 'optional skill content');
    await fs.writeJson(path.join(repoDir, '.xtrm', 'skills', 'state.json'), { schemaVersion: '1' });
    await fs.writeJson(path.join(repoDir, 'package.json'), { name: 'test-repo', version: '1.0.0' });
    return { repoDir, backupDir: path.join(tmpHome, '.xtrm', 'migration-backups') };
  }

  function findBackup(backupDir: string, prefix: string): string {
    const backups = fs.readdirSync(backupDir);
    const match = backups.find((f) => f.startsWith(prefix) && f.endsWith('.tgz'));
    expect(match).toBeDefined();
    return path.join(backupDir, match!);
  }

  it('restores a valid skills backup produced by xtrm migrate', async () => {
    const { repoDir, backupDir } = await seedSkillsRepo();
    runCli(['migrate', 'skills', '--apply', '--yes', '--repo', repoDir], repoDir);
    expect(await fs.pathExists(path.join(repoDir, '.xtrm', 'skills', 'default'))).toBe(false);

    const backupPath = findBackup(backupDir, 'skills-test-repo');
    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('restored');
    expect(await fs.readFile(path.join(repoDir, '.xtrm', 'skills', 'default', 'test-skill.md'), 'utf8')).toBe('test skill content');
    expect(await fs.readFile(path.join(repoDir, '.xtrm', 'skills', 'optional', 'optional-skill.md'), 'utf8')).toBe('optional skill content');
    expect(await fs.readJson(path.join(repoDir, '.xtrm', 'skills', 'state.json'))).toEqual({ schemaVersion: '1' });
  });

  it('restores deep skill paths that force GNU long-name entries', async () => {
    const { repoDir, backupDir } = await seedSkillsRepo();
    const deepRel = ['very', 'deep', 'nested', 'path', 'with', 'many', 'segments', 'that', 'exceeds', 'the', 'hundred', 'character', 'limit', 'for', 'sure', 'now', 'x', 'y', 'z', 'deepfile.md'];
    const deepAbs = path.join(repoDir, '.xtrm', 'skills', 'default', ...deepRel);
    await fs.ensureDir(path.dirname(deepAbs));
    await fs.writeFile(deepAbs, 'deep content');
    expect(`skills/default/${deepRel.join('/')}`.length).toBeGreaterThan(100);

    runCli(['migrate', 'skills', '--apply', '--yes', '--repo', repoDir], repoDir);
    const backupPath = findBackup(backupDir, 'skills-test-repo');

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(deepAbs, 'utf8')).toBe('deep content');
  });

  it('preserves executable permissions from the backup', async () => {
    const repoDir = path.join(tmpHome, 'test-repo');
    await fs.ensureDir(path.join(repoDir, '.xtrm', 'hooks'));
    await fs.writeFile(path.join(repoDir, '.xtrm', 'hooks', 'run-hook.mjs'), 'console.log(1);');
    await fs.chmod(path.join(repoDir, '.xtrm', 'hooks', 'run-hook.mjs'), 0o755);
    await fs.writeJson(path.join(repoDir, 'package.json'), { name: 'test-repo', version: '1.0.0' });

    runCli(['migrate', 'hooks', '--apply', '--yes', '--repo', repoDir], repoDir);
    const backupPath = findBackup(path.join(tmpHome, '.xtrm', 'migration-backups'), 'hooks-test-repo');

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(0);
    const restored = path.join(repoDir, '.xtrm', 'hooks', 'run-hook.mjs');
    expect(await fs.readFile(restored, 'utf8')).toBe('console.log(1);');
    const st = await fs.stat(restored);
    expect(st.mode & 0o777).toBe(0o755);
  });

  it('restores a valid hooks backup (with settings sidecar intact)', async () => {
    const repoDir = path.join(tmpHome, 'test-repo');
    await fs.ensureDir(path.join(repoDir, '.xtrm', 'hooks'));
    await fs.writeFile(path.join(repoDir, '.xtrm', 'hooks', 'test-hook.mjs'), 'console.log("hook");');
    await fs.ensureDir(path.join(repoDir, '.claude'));
    await fs.writeJson(path.join(repoDir, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ _source: 'xtrm-global', matcher: 'Bash', hooks: [] }] } }, { spaces: 2 });
    await fs.writeJson(path.join(repoDir, 'package.json'), { name: 'test-repo', version: '1.0.0' });

    runCli(['migrate', 'hooks', '--apply', '--yes', '--repo', repoDir], repoDir);
    const backupDir = path.join(tmpHome, '.xtrm', 'migration-backups');
    const backupPath = findBackup(backupDir, 'hooks-test-repo');

    const result = restoreCmd(backupPath, repoDir);

    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(repoDir, '.xtrm', 'hooks', 'test-hook.mjs'), 'utf8')).toBe('console.log("hook");');
    expect(await fs.readJson(path.join(repoDir, '.claude', 'settings.json'))).toEqual({ hooks: { PreToolUse: [{ _source: 'xtrm-global', matcher: 'Bash', hooks: [] }] } });
  });
});
