import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const claudeConfig = path.join(repoRoot, '.xtrm', 'config', 'claude.mcp.json');
const piConfig = path.join(repoRoot, '.xtrm', 'config', 'pi.mcp.json');

const CURRENT_TOOLS = [
  'web_search_exa',
  'web_fetch_exa',
  'web_search_advanced_exa',
  'agent_run',
];

const RETIRED_TOOLS = [
  'deep_researcher_start',
  'crawling_exa',
  'get_code_context_exa',
];

describe('managed Exa MCP baseline', () => {
  it('ships the current Exa tool set for Claude without embedding credentials', async () => {
    const config = await fs.readJson(claudeConfig);
    const exa = config.mcpServers.exa;

    expect(exa.type).toBe('http');
    expect(exa.url).toContain('https://mcp.exa.ai/mcp?tools=');
    for (const tool of CURRENT_TOOLS) expect(exa.url).toContain(tool);
    for (const tool of RETIRED_TOOLS) expect(exa.url).not.toContain(tool);
    expect(exa.headers?.['x-api-key']).toBe('${EXA_API_KEY}');
    expect(JSON.stringify(exa)).not.toContain('exaApiKey=');
    expect(JSON.stringify(exa)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('ships Exa as a native Pi HTTP MCP without embedding credentials', async () => {
    // Remote Pi entries use native HTTP servers, served by Pi's built-in MCP client
    // (CORE-2399). The retired adapter bridge rejected a positional URL as an unknown command.
    const config = await fs.readJson(piConfig);
    const exa = config.mcpServers.exa;

    expect(exa.type).toBe('http');
    expect(exa.url).toContain('https://mcp.exa.ai/mcp?tools=');
    for (const tool of CURRENT_TOOLS) expect(exa.url).toContain(tool);
    for (const tool of RETIRED_TOOLS) expect(exa.url).not.toContain(tool);
    expect(exa.headers?.['x-api-key']).toBe('${EXA_API_KEY}');
    expect(JSON.stringify(exa)).not.toContain('exaApiKey=');
    expect(JSON.stringify(exa)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('serves deepwiki and github-grep as built-in Pi HTTP MCP servers, never an npx bridge', async () => {
    // CORE-2399: Pi has built-in MCP, so no server may pass a URL as an npx argument
    // (the retired bridge shape) and both remote servers must be native `url` entries.
    const config = await fs.readJson(piConfig);

    expect(config.mcpServers.deepwiki).toMatchObject({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
    expect(config.mcpServers['github-grep']).toMatchObject({ type: 'http', url: 'https://mcp.grep.app' });

    const bridged = Object.entries(config.mcpServers as Record<string, { args?: unknown }>)
      .filter(([, server]) => Array.isArray(server.args)
        && (server.args as unknown[]).some((arg) => typeof arg === 'string' && arg.startsWith('http')))
      .map(([name]) => name);
    expect(bridged).toEqual([]);
  });
});
