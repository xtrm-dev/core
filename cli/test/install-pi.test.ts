import { describe, it, expect, vi } from 'vitest';
import { createInstallPiCommand } from '../src/commands/install-pi.js';

describe('createInstallPiCommand', () => {
    it('exports a createInstallPiCommand function', () => {
        expect(typeof createInstallPiCommand).toBe('function');
    });

    it('returns a Command named "pi"', () => {
        const cmd = createInstallPiCommand();
        expect((cmd as any).name()).toBe('pi');
    });

    it('fillTemplate replaces {{PLACEHOLDERS}} with values', async () => {
        const { fillTemplate } = await import('../src/commands/install-pi.js');
        expect(fillTemplate('{"k":"{{MY_KEY}}"}' , { MY_KEY: 'abc' })).toBe('{"k":"abc"}');
    });

    it('fillTemplate leaves missing placeholders empty', async () => {
        const { fillTemplate } = await import('../src/commands/install-pi.js');
        expect(fillTemplate('{"k":"{{MISSING}}"}', {})).toBe('{"k":""}');
    });

    it('models.json.template contains {{DASHSCOPE_API_KEY}}', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const content = fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'models.json.template'), 'utf8');
        expect(content).toContain('{{DASHSCOPE_API_KEY}}');
    });

    it('auth.json.template contains {{DASHSCOPE_API_KEY}} and {{ZAI_API_KEY}}', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const content = fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'auth.json.template'), 'utf8');
        expect(content).toContain('{{DASHSCOPE_API_KEY}}');
        expect(content).toContain('{{ZAI_API_KEY}}');
    });

    it('auth.json.template contains no real API keys or tokens', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const content = fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'auth.json.template'), 'utf8');
        expect(content).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
        expect(content).not.toMatch(/ya29\.[a-zA-Z0-9_-]{20,}/);
    });

    it('settings.json.template includes pi-serena-tools package', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const settings = JSON.parse(fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'settings.json.template'), 'utf8'));
        expect(settings.packages).toContain('npm:pi-serena-tools');
    });

    it('settings.json.template includes @zenobius/pi-worktrees package', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const settings = JSON.parse(fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'settings.json.template'), 'utf8'));
        expect(settings.packages).toContain('npm:@zenobius/pi-worktrees');
    });

    it('copyExtraConfigs copies missing files and skips existing ones', async () => {
        const { copyExtraConfigs, EXTRA_PI_CONFIGS } = await import('../src/commands/install-pi.js?t=copy' + Date.now());
        const os = require('node:os');
        const nodePath = require('node:path');
        const nodeFs = require('node:fs');
        const srcDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'pi-src-'));
        const destDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'pi-dest-'));
        // Create src file
        nodeFs.writeFileSync(nodePath.join(srcDir, 'pi-worktrees-settings.json'), '{"worktree":{}}');
        await copyExtraConfigs(srcDir, destDir);
        // Should have been copied
        expect(nodeFs.existsSync(nodePath.join(destDir, 'pi-worktrees-settings.json'))).toBe(true);
        // Second call should skip (not throw)
        await copyExtraConfigs(srcDir, destDir);
        nodeFs.rmSync(srcDir, { recursive: true });
        nodeFs.rmSync(destDir, { recursive: true });
    });

    it('EXTRA_PI_CONFIGS includes pi-worktrees-settings.json', async () => {
        const { EXTRA_PI_CONFIGS } = await import('../src/commands/install-pi.js?t=extra' + Date.now());
        expect(EXTRA_PI_CONFIGS).toContain('pi-worktrees-settings.json');
    });

    it('pi-worktrees-settings.json exists in config/pi with worktree.parentDir defined', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const cfg = JSON.parse(fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'pi-worktrees-settings.json'), 'utf8'));
        expect(cfg.worktree).toBeDefined();
        expect(cfg.worktree.parentDir).toBeDefined();
    });

    it('install-schema.json defines DASHSCOPE_API_KEY and ZAI_API_KEY fields', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const schema = JSON.parse(fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'install-schema.json'), 'utf8'));
        const keys = schema.fields.map((f) => f.key);
        expect(keys).toContain('DASHSCOPE_API_KEY');
        expect(keys).toContain('ZAI_API_KEY');
    });

    it('install-schema.json lists anthropic and qwen-cli as oauth_providers', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const schema = JSON.parse(fs.readFileSync(p.resolve(__dirname, '..', '..', 'config', 'pi', 'install-schema.json'), 'utf8'));
        const keys = schema.oauth_providers.map((o) => o.key);
        expect(keys).toContain('anthropic');
        expect(keys).toContain('qwen-cli');
    });

    it('extensions directory resolves from current runtime source', async () => {
        const { resolveManagedPiExtensionsSourceDir } = await import('../src/core/pi-runtime.js?t=' + Date.now());
        const path = require('node:path');
        const sourceDir = resolveManagedPiExtensionsSourceDir();
        expect(sourceDir).toBe(path.resolve(__dirname, '..', '..', 'packages', 'pi-extensions', 'extensions'));
    });

    it('custom-provider-qwen-cli extension has index.ts and package.json', () => {
        const fs = require('node:fs');
        const p = require('node:path');
        const base = p.resolve(__dirname, '..', '..', 'packages', 'pi-extensions', 'extensions', 'custom-provider-qwen-cli');
        expect(fs.existsSync(p.join(base, 'index.ts'))).toBe(true);
        expect(fs.existsSync(p.join(base, 'package.json'))).toBe(true);
    });

    it('readExistingPiValues extracts DASHSCOPE_API_KEY from existing auth.json', async () => {
        const { readExistingPiValues } = await import('../src/commands/install-pi.js?t=' + Date.now());
        const tmpDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pi-test-'));
        require('node:fs').writeFileSync(require('node:path').join(tmpDir, 'auth.json'), JSON.stringify({ dashscope: { type: 'api_key', key: 'sk-existing-123' } }));
        const result = readExistingPiValues(tmpDir);
        require('node:fs').rmSync(tmpDir, { recursive: true });
        expect(result['DASHSCOPE_API_KEY']).toBe('sk-existing-123');
    });

    it('readExistingPiValues extracts ZAI_API_KEY from existing auth.json', async () => {
        const { readExistingPiValues } = await import('../src/commands/install-pi.js?t=' + Date.now());
        const tmpDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pi-test-'));
        require('node:fs').writeFileSync(require('node:path').join(tmpDir, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'zai-existing-456' } }));
        const result = readExistingPiValues(tmpDir);
        require('node:fs').rmSync(tmpDir, { recursive: true });
        expect(result['ZAI_API_KEY']).toBe('zai-existing-456');
    });

    it('readExistingPiValues returns empty object when auth.json missing', async () => {
        const { readExistingPiValues } = await import('../src/commands/install-pi.js?t=' + Date.now());
        expect(readExistingPiValues('/nonexistent/path')).toEqual({});
    });

    it('readExistingPiValues extracts DASHSCOPE_API_KEY from models.json when auth.json missing', async () => {
        const { readExistingPiValues } = await import('../src/commands/install-pi.js?t=models' + Date.now());
        const tmpDir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pi-test-'));
        require('node:fs').writeFileSync(require('node:path').join(tmpDir, 'models.json'), JSON.stringify({ providers: { dashscope: { apiKey: 'sk-from-models-789' } } }));
        const result = readExistingPiValues(tmpDir);
        require('node:fs').rmSync(tmpDir, { recursive: true });
        expect(result['DASHSCOPE_API_KEY']).toBe('sk-from-models-789');
    });

    it('diffPiExtensions reports missing and stale extension packages', async () => {
        const { diffPiExtensions } = await import('../src/utils/pi-extensions.js?t=diff' + Date.now());
        const nodeFs = require('node:fs');
        const nodePath = require('node:path');
        const os = require('node:os');

        const srcDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'pi-ext-src-'));
        const dstDir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'pi-ext-dst-'));

        nodeFs.mkdirSync(nodePath.join(srcDir, 'a'));
        nodeFs.writeFileSync(nodePath.join(srcDir, 'a', 'package.json'), JSON.stringify({ name: 'a' }));
        nodeFs.writeFileSync(nodePath.join(srcDir, 'a', 'index.ts'), 'export const a = 1;');

        nodeFs.mkdirSync(nodePath.join(srcDir, 'b'));
        nodeFs.writeFileSync(nodePath.join(srcDir, 'b', 'package.json'), JSON.stringify({ name: 'b' }));
        nodeFs.writeFileSync(nodePath.join(srcDir, 'b', 'index.ts'), 'export const b = 1;');

        nodeFs.mkdirSync(nodePath.join(dstDir, 'a'));
        nodeFs.writeFileSync(nodePath.join(dstDir, 'a', 'package.json'), JSON.stringify({ name: 'a' }));
        nodeFs.writeFileSync(nodePath.join(dstDir, 'a', 'index.ts'), 'export const a = 2;');

        const diff = await diffPiExtensions(srcDir, dstDir);

        expect(diff.missing).toContain('b');
        expect(diff.stale).toContain('a');

        nodeFs.rmSync(srcDir, { recursive: true, force: true });
        nodeFs.rmSync(dstDir, { recursive: true, force: true });
    });

    it('createInstallPiCommand supports --check flag', () => {
        const cmd = createInstallPiCommand();
        const hasCheck = (cmd as any).options.some((opt: any) => opt.long === '--check');
        expect(hasCheck).toBe(true);
    });

    it('--check skips cleanly when managed extension source is unavailable', async () => {
        vi.resetModules();
        vi.doMock('../src/core/pi-runtime.js', async () => {
            const actual = await vi.importActual<typeof import('../src/core/pi-runtime.js')>('../src/core/pi-runtime.js');
            return {
                ...actual,
                resolveManagedPiExtensionsSourceDir: vi.fn(() => null),
            };
        });
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { createInstallPiCommand: createCommand } = await import('../src/commands/install-pi.js?t=check-null-' + Date.now());
        const cmd = createCommand();
        await (cmd as any)._actionHandler([], { check: true, yes: false, setup: false });
        expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('Managed extensions: skipped'));
        expect(consoleError).not.toHaveBeenCalled();
        consoleLog.mockRestore();
        consoleError.mockRestore();
    });

    it('createInstallPiCommand supports --setup flag for first-time config writes', () => {
        const cmd = createInstallPiCommand();
        const hasSetup = (cmd as any).options.some((opt: any) => opt.long === '--setup');
        expect(hasSetup).toBe(true);
    });
});
