import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

interface RegistryFileEntry {
  hash: string;
  version: string;
}

interface RegistryAsset {
  source_dir: string;
  install_mode: 'copy' | 'symlink';
  files: Record<string, RegistryFileEntry>;
}

interface RegistryManifest {
  version: string;
  assets: Record<string, RegistryAsset>;
}

interface RegistrySchemaCase {
  name: string;
  manifest: unknown;
  expectedError?: string;
}

const SHA256_REGEX = /^[a-f0-9]{64}$/;
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function createTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-registry-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function parseRegistryManifest(input: unknown): RegistryManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('registry must be an object');
  }

  const candidate = input as Partial<RegistryManifest>;

  if (candidate.version !== '1') {
    throw new Error('registry.version must be "1"');
  }

  if (!candidate.assets || typeof candidate.assets !== 'object') {
    throw new Error('registry.assets must be an object');
  }

  for (const [assetName, asset] of Object.entries(candidate.assets)) {
    if (!asset || typeof asset !== 'object') {
      throw new Error(`asset ${assetName} must be an object`);
    }

    if (typeof asset.source_dir !== 'string' || asset.source_dir.length === 0) {
      throw new Error(`asset ${assetName} missing source_dir`);
    }

    if (asset.install_mode !== 'copy' && asset.install_mode !== 'symlink') {
      throw new Error(`asset ${assetName} has invalid install_mode`);
    }

    if (!asset.files || typeof asset.files !== 'object') {
      throw new Error(`asset ${assetName} missing files`);
    }

    for (const [fileName, fileEntry] of Object.entries(asset.files)) {
      if (!fileEntry || typeof fileEntry !== 'object') {
        throw new Error(`asset ${assetName} file ${fileName} must be an object`);
      }

      if (typeof fileEntry.hash !== 'string' || !SHA256_REGEX.test(fileEntry.hash)) {
        throw new Error(`asset ${assetName} file ${fileName} has invalid sha256 hash`);
      }

      if (typeof fileEntry.version !== 'string' || fileEntry.version.length === 0) {
        throw new Error(`asset ${assetName} file ${fileName} missing version`);
      }
    }
  }

  return candidate as RegistryManifest;
}

async function writeFileWithParents(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function createGenRegistryFixture(tempRoot: string): Promise<void> {
  await writeFileWithParents(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.7.0' }, null, 2),
  );

  await writeFileWithParents(path.join(tempRoot, '.xtrm', 'hooks', 'post-tool-use.mjs'), 'export default 1;\n');
  await writeFileWithParents(path.join(tempRoot, '.xtrm', 'skills', 'default', 'README.md'), '# skill\n');
  await writeFileWithParents(path.join(tempRoot, '.xtrm', 'config', 'settings.json'), '{"ok":true}\n');
  await writeFileWithParents(path.join(tempRoot, '.xtrm', 'extensions', 'beads', 'index.ts'), 'export {};\n');

  const sourceScript = path.resolve(process.cwd(), '..', 'scripts', 'gen-registry.mjs');
  const scriptContent = await fs.readFile(sourceScript, 'utf8');
  await writeFileWithParents(path.join(tempRoot, 'scripts', 'gen-registry.mjs'), scriptContent);

  spawnSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' });
}

async function runGenRegistry(tempRoot: string): Promise<void> {
  const result = spawnSync('node', [path.join('scripts', 'gen-registry.mjs')], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  expect(result.status, `gen-registry failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

const schemaCases: RegistrySchemaCase[] = [
  {
    name: 'accepts a valid registry manifest',
    manifest: {
      version: '1',
      assets: {
        hooks: {
          source_dir: '.xtrm/hooks',
          install_mode: 'copy',
          files: {
            'a.mjs': { hash: sha256('hello'), version: '0.7.0' },
          },
        },
      },
    } satisfies RegistryManifest,
  },
  {
    name: 'rejects a registry without version',
    manifest: { assets: {} },
    expectedError: 'registry.version must be "1"',
  },
  {
    name: 'rejects non-sha256 hash values',
    manifest: {
      version: '1',
      assets: {
        hooks: {
          source_dir: '.xtrm/hooks',
          install_mode: 'copy',
          files: {
            'a.mjs': { hash: 'not-a-sha256', version: '0.7.0' },
          },
        },
      },
    },
    expectedError: 'invalid sha256 hash',
  },
  {
    name: 'accepts an empty assets object',
    manifest: { version: '1', assets: {} },
  },
];

describe('registry.json schema', () => {
  describe.each(schemaCases)('$name', ({ manifest, expectedError }) => {
    it('validates manifest', () => {
      if (expectedError) {
        expect(() => parseRegistryManifest(manifest)).toThrow(expectedError);
        return;
      }

      expect(() => parseRegistryManifest(manifest)).not.toThrow();
    });
  });
});

describe('gen-registry idempotence', () => {
  it('produces identical registry hash when run twice', async () => {
    const tempRoot = await createTempDir();
    await createGenRegistryFixture(tempRoot);

    await runGenRegistry(tempRoot);
    const firstOutput = await fs.readFile(path.join(tempRoot, '.xtrm', 'registry.json'), 'utf8');
    const firstHash = sha256(firstOutput);

    await runGenRegistry(tempRoot);
    const secondOutput = await fs.readFile(path.join(tempRoot, '.xtrm', 'registry.json'), 'utf8');
    const secondHash = sha256(secondOutput);

    expect(secondHash).toBe(firstHash);
    expect(secondOutput).toBe(firstOutput);

    const parsed = parseRegistryManifest(JSON.parse(secondOutput));
    expect(Object.keys(parsed.assets).sort()).toEqual(['config', 'hooks', 'pi_extensions', 'skills', 'skills_optional']);
    expect(parsed.assets.skills_optional.files).toEqual({});
  });
});
