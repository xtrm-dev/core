import { describe, expect, it } from 'vitest';
import { deepMergeWithProtection } from '../src/utils/atomic-config.js';

describe('deepMergeWithProtection (hooks merge behavior)', () => {
    it('upgrades matcher tokens for same hook command without duplicating hook', () => {
        const local = {
            hooks: {
                PostToolUse: [{
                    matcher: 'Write|Edit|MultiEdit',
                    hooks: [{ command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/quality-check.py"' }],
                }],
            },
        };

        const incoming = {
            hooks: {
                PostToolUse: [{
                    matcher: 'Write|Edit|MultiEdit|mcp__serena__rename_symbol|mcp__serena__replace_symbol_body|mcp__serena__insert_after_symbol|mcp__serena__insert_before_symbol',
                    hooks: [{ command: 'python3 "$CLAUDE_PROJECT_DIR/hooks/quality-check.py"' }],
                }],
            },
        };

        const merged = deepMergeWithProtection(local, incoming);
        const wrappers = merged.hooks.PostToolUse;
        expect(wrappers).toHaveLength(1);
        expect(wrappers[0].matcher).toContain('mcp__serena__insert_after_symbol');
        expect(wrappers[0].matcher).toContain('mcp__serena__insert_before_symbol');
        expect(wrappers[0].matcher).toContain('mcp__serena__rename_symbol');
        expect(wrappers[0].matcher).toContain('mcp__serena__replace_symbol_body');
        expect(wrappers[0].hooks).toHaveLength(1);
    });

    it('preserves local custom hooks and still installs incoming wrappers', () => {
        const local = {
            hooks: {
                PreToolUse: [{
                    matcher: 'Write',
                    hooks: [{ command: 'node /custom/local-hook.mjs' }],
                }],
            },
        };

        const incoming = {
            hooks: {
                PreToolUse: [{
                    matcher: 'Edit',
                    hooks: [{ command: 'node /repo/hooks/main-guard.mjs' }],
                }],
                PostToolUse: [{
                    matcher: 'Edit',
                    hooks: [{ command: 'node /repo/hooks/main-guard-post-push.mjs' }],
                }],
            },
        };

        const merged = deepMergeWithProtection(local, incoming);
        expect(merged.hooks.PreToolUse).toHaveLength(2);
        expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe('node /custom/local-hook.mjs');
        expect(merged.hooks.PreToolUse[1].hooks[0].command).toBe('node /repo/hooks/main-guard.mjs');
        expect(merged.hooks.PostToolUse).toHaveLength(1);
    });

    it('keeps protected non-hook keys unchanged', () => {
        const local = {
            model: 'claude-sonnet',
            hooks: {
                SessionStart: [{ hooks: [{ command: 'echo start-local' }] }],
            },
        };

        const incoming = {
            model: 'claude-opus',
            hooks: {
                SessionStart: [{ hooks: [{ command: 'echo start-repo' }] }],
            },
        };

        const merged = deepMergeWithProtection(local, incoming);
        expect(merged.model).toBe('claude-sonnet');
        expect(merged.hooks.SessionStart).toHaveLength(2);
    });
});


describe('deepMergeWithProtection (hooks merge behavior) — matcher dedup', () => {
    it('keeps two same-script entries separate when their matchers are disjoint', () => {
        // Simulates config/hooks.json having main-guard wired for write-tools
        // AND separately for Bash — they must not be merged into one entry
        const local = {
            hooks: {
                PreToolUse: [] as any[],
            },
        };
        const incoming = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Write|Edit|MultiEdit',
                        hooks: [{ command: 'node "/hooks/main-guard.mjs"', timeout: 5000 }],
                    },
                    {
                        matcher: 'Bash',
                        hooks: [{ command: 'node "/hooks/main-guard.mjs"', timeout: 5000 }],
                    },
                ],
            },
        };
        const merged = deepMergeWithProtection(local, incoming);
        const wrappers = merged.hooks.PreToolUse;
        expect(wrappers).toHaveLength(2);
        expect(wrappers[0].matcher).toBe('Write|Edit|MultiEdit');
        expect(wrappers[1].matcher).toBe('Bash');
    });

    it('still upgrades matcher when entries share at least one common token', () => {
        const local = {
            hooks: {
                PreToolUse: [{
                    matcher: 'Write|Edit',
                    hooks: [{ command: 'node "/hooks/main-guard.mjs"' }],
                }],
            },
        };
        const incoming = {
            hooks: {
                PreToolUse: [{
                    matcher: 'Write|Edit|MultiEdit',
                    hooks: [{ command: 'node "/hooks/main-guard.mjs"' }],
                }],
            },
        };
        const merged = deepMergeWithProtection(local, incoming);
        const wrappers = merged.hooks.PreToolUse;
        expect(wrappers).toHaveLength(1);
        expect(wrappers[0].matcher).toContain('MultiEdit');
    });
});

describe('deepMergeWithProtection prototype pollution guard', () => {
    it('refuses __proto__/constructor/prototype keys', () => {
        const local = {};
        const incoming = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true},"safe":{"x":1}}');
        const merged = deepMergeWithProtection(local, incoming);
        expect(({} as any).polluted).toBeUndefined();
        expect(merged.safe).toEqual({ x: 1 });
        expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false);
    });
});
