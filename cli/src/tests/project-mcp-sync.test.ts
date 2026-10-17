import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncPiMcpConfig, syncProjectMcpConfig } from '../core/project-mcp-sync.js';

let projectRoot = '';
let previousContext7: string | undefined;

beforeEach(async () => {
  previousContext7 = process.env.CONTEXT7_API_KEY;
  delete process.env.CONTEXT7_API_KEY;

  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-mcp-sync-'));
  await fs.ensureDir(path.join(projectRoot, '.xtrm', 'config'));

  await fs.writeJson(path.join(projectRoot, '.xtrm', 'config', 'claude.mcp.json'), {
    mcpServers: {
      context7: {
        type: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: {
          CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}',
        },
      },
      'github-grep': {
        type: 'http',
        url: 'https://mcp.grep.app',
      },
      deepwiki: {
        type: 'http',
        url: 'https://mcp.deepwiki.com/mcp',
      },
      gitnexus: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'gitnexus', 'mcp'],
      },
    },
  }, { spaces: 2 });

  await fs.writeJson(path.join(projectRoot, '.xtrm', 'config', 'pi.mcp.json'), {
    mcpServers: {
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        lifecycle: 'lazy',
        idleTimeout: 10,
        _note: 'sanitized',
      },
      deepwiki: {
        type: 'http',
        url: 'https://mcp.deepwiki.com/mcp',
        lifecycle: 'lazy',
        idleTimeout: 10,
      },
      'github-grep': {
        type: 'http',
        url: 'https://mcp.grep.app',
        lifecycle: 'lazy',
        idleTimeout: 10,
      },
      gitnexus: {
        command: 'gitnexus',
        args: ['mcp'],
        lifecycle: 'lazy',
        idleTimeout: 10,
      },
      specialists: {
        command: 'specialists',
        args: [],
        lifecycle: 'lazy',
        idleTimeout: 10,
      },
    },
  }, { spaces: 2 });
});

afterEach(async () => {
  if (previousContext7) {
    process.env.CONTEXT7_API_KEY = previousContext7;
  } else {
    delete process.env.CONTEXT7_API_KEY;
  }
  await fs.remove(projectRoot);
});

describe('syncProjectMcpConfig', () => {
  it('creates .mcp.json from canonical config', async () => {
    const result = await syncProjectMcpConfig(projectRoot);
    const mcpPath = path.join(projectRoot, '.mcp.json');

    expect(result.createdFile).toBe(true);
    expect(result.wroteFile).toBe(true);
    expect(result.addedServers).toEqual(expect.arrayContaining([
      'context7',
      'github-grep',
      'deepwiki',
      'gitnexus',
    ]));
    expect(result.missingEnvWarnings).toContain('context7: missing CONTEXT7_API_KEY');

    const content = await fs.readJson(mcpPath);
    expect(Object.keys(content.mcpServers)).toEqual(expect.arrayContaining([
      'context7',
      'github-grep',
      'deepwiki',
      'gitnexus',
    ]));
  });

  it('is idempotent and preserves user-added servers on rerun', async () => {
    await syncProjectMcpConfig(projectRoot);

    const mcpPath = path.join(projectRoot, '.mcp.json');
    const first = await fs.readJson(mcpPath);
    first.mcpServers.custom = {
      type: 'stdio',
      command: 'node',
      args: ['custom-mcp.js'],
    };
    await fs.writeJson(mcpPath, first, { spaces: 2 });

    const secondRun = await syncProjectMcpConfig(projectRoot);
    expect(secondRun.wroteFile).toBe(false);
    expect(secondRun.addedServers).toEqual([]);

    const second = await fs.readJson(mcpPath);
    expect(second.mcpServers.custom).toEqual(first.mcpServers.custom);

    const canonicalKeys = Object.keys(second.mcpServers).filter((name) => name === 'gitnexus');
    expect(canonicalKeys).toHaveLength(1);
  });

  it('preserves existing .mcp.json when preserveExistingFile is enabled', async () => {
    const mcpPath = path.join(projectRoot, '.mcp.json');
    await fs.writeJson(mcpPath, {
      mcpServers: {
        custom: {
          type: 'stdio',
          command: 'node',
          args: ['custom-mcp.js'],
        },
      },
    }, { spaces: 2 });

    const before = await fs.readFile(mcpPath, 'utf8');
    const result = await syncProjectMcpConfig(projectRoot, { preserveExistingFile: true });
    const after = await fs.readFile(mcpPath, 'utf8');

    expect(result.wroteFile).toBe(false);
    expect(result.createdFile).toBe(false);
    expect(result.preservedExistingFile).toBe(true);
    expect(result.addedServers).toEqual([]);
    expect(after).toBe(before);
  });

  it('handles missing canonical config gracefully', async () => {
    await fs.remove(path.join(projectRoot, '.xtrm', 'config', 'claude.mcp.json'));

    const result = await syncProjectMcpConfig(projectRoot);

    expect(result.wroteFile).toBe(false);
    expect(result.createdFile).toBe(false);
    expect(result.addedServers).toEqual([]);
    expect(result.missingEnvWarnings[0]).toContain('canonical MCP config not found');
  });

  it('supports dry run without writing files', async () => {
    const result = await syncProjectMcpConfig(projectRoot, { dryRun: true });
    expect(result.wroteFile).toBe(true);
    expect(await fs.pathExists(path.join(projectRoot, '.mcp.json'))).toBe(false);
  });
});

describe('syncPiMcpConfig', () => {
  it('creates .pi/mcp.json from canonical pi config', async () => {
    const result = await syncPiMcpConfig(projectRoot);
    const mcpPath = path.join(projectRoot, '.pi', 'mcp.json');

    expect(result.createdFile).toBe(true);
    expect(result.wroteFile).toBe(true);
    expect(result.addedServers).toEqual(expect.arrayContaining([
      'context7',
      'deepwiki',
      'github-grep',
      'gitnexus',
      'specialists',
    ]));

    const content = await fs.readJson(mcpPath);
    expect(content.mcpServers.context7.lifecycle).toBe('lazy');
    expect(content.mcpServers.context7.idleTimeout).toBe(10);
    expect(content.mcpServers.context7._note).toBeUndefined();
    // CORE-2399: the synced remote entries stay native HTTP url servers, never an npx bridge.
    expect(content.mcpServers.deepwiki).toMatchObject({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
    expect(content.mcpServers['github-grep']).toMatchObject({ type: 'http', url: 'https://mcp.grep.app' });
  });

  it('preserves existing user entries and settings on rerun', async () => {
    await fs.ensureDir(path.join(projectRoot, '.pi'));
    await fs.writeJson(path.join(projectRoot, '.pi', 'mcp.json'), {
      settings: { idleTimeout: 10 },
      mcpServers: {
        specialists: {
          command: 'specialists',
          args: ['--local-only'],
          lifecycle: 'lazy',
          idleTimeout: 10,
        },
        custom: {
          command: 'node',
          args: ['custom-mcp.js'],
          lifecycle: 'lazy',
          idleTimeout: 10,
        },
      },
    }, { spaces: 2 });

    const result = await syncPiMcpConfig(projectRoot);
    expect(result.addedServers).toEqual(expect.arrayContaining(['context7', 'deepwiki', 'github-grep', 'gitnexus']));

    const merged = await fs.readJson(path.join(projectRoot, '.pi', 'mcp.json'));
    expect(merged.settings).toEqual({ idleTimeout: 10 });
    expect(merged.mcpServers.specialists.args).toEqual(['--local-only']);
    expect(merged.mcpServers.custom).toBeDefined();
  });

  it('supports dry run without writing pi config', async () => {
    const result = await syncPiMcpConfig(projectRoot, { dryRun: true });
    expect(result.wroteFile).toBe(true);
    expect(await fs.pathExists(path.join(projectRoot, '.pi', 'mcp.json'))).toBe(false);
  });
});
