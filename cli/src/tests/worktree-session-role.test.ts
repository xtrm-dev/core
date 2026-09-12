import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClaudeCommand } from '../commands/claude.js';
import { createPiCommand } from '../commands/pi.js';
import {
    assertClaudeSkillsDiscoverable,
    assertClaudePackSkillsLoadable,
    buildAgentEnv,
    buildBufferedRuntimeCommand,
    buildBareTmuxPlan,
    buildRoleTmuxPlan,
    checkByteCeiling,
    checkPositionZeroSlash,
    chooseAttachCommand,
    createRuntimeBufferName,
    effectiveModel,
    ensureClaudePackSkillLinks,
    claudeExplicitSkillLines,
    guardRolePassthrough,
    isForeignProviderModel,
    parseSpecialistJson,
    passthroughModels,
    probeSkillPrefixAvailable,
    renderDeclaredSkillPrefix,
    renderRoleTask,
    renderSkillPrefix,
    bindClaudePackNames,
    composeClaudeExplicitLines,
    composeClaudeRoleBlock,
    claudeExplicitLinesFor,
    resolveProjectPackEntry,
    resolveRequestedSkills,
    resolveRole,
    resolveSkillPath,
    rollbackLauncherWorktree,
    type ClaudePackSkillEntry,
} from '../utils/worktree-session.js';

// Every plan carries the worktree + branch it publishes as lineage metadata
// (audit P1-02), so the builders require both. Tests whose subject is not
// lineage spread these in rather than restating them. xtrm-6hey0.2.
const WT = {
    worktreePath: '/repo/.xtrm/worktrees/repo-xt-pi-demo',
    branchName: 'xt/demo',
    // Launcher-owned session display name — the worktree slug (xtrm-rhmm1).
    sessionDisplayName: 'repo-xt-pi-demo',
} as const;

// Declared skill paths stay verbatim in the role: resolution happens once in
// resolveRequestedSkills (xtrm-lk07w.14), so bare pack names keep their form
// instead of being frozen into nonexistent repo-resolved paths. Plan-level
// tests derive '/<name>' from these the same way for both forms.
const SAMPLE_SPECIALIST = JSON.stringify({
    specialist: {
        metadata: { name: 'chain-coordinator' },
        prompt: {
            system: 'You are the chain coordinator.\nDo the thing.',
        },
        skills: {
            paths: [
                '.xtrm/skills/test-only/synthetic-a/SKILL.md',
                '.xtrm/skills/test-only/synthetic-b/SKILL.md',
            ],
        },
    },
});

// Helpers to spawn a temp sandbox with a fake `sp` binary of the caller's
// choosing. Individual tests decide how the fake responds. Keeps process env
// clean.
function withFakeSp(script: string, run: () => void): void {
    const sandbox = path.join(os.tmpdir(), `xtrm-sp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const bin = path.join(sandbox, 'bin');
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'sp'), script);
    chmodSync(path.join(bin, 'sp'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try { run(); } finally {
        process.env.PATH = previousPath;
        rmSync(sandbox, { recursive: true, force: true });
    }
}

describe('renderRoleTask', () => {
    const capture = path.join(os.tmpdir(), `xtrm-render-task-capture-${process.pid}`);

    function withRenderTaskSp(fail: boolean, run: () => void): void {
        const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.XTRM_RENDER_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.XTRM_RENDER_FAIL === '1') {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'bead_not_found', message: 'missing bead' } }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  ok: true,
  initial_prompt: "line one\\n$vars and 'quotes' survive",
  prompt_hash: '0123456789abcdef',
  components: [{ kind: 'task_template', name: 'task_template', tokens: 8, bytes: 32 }],
  skills: ['~/.xtrm/skills/default/multiplexing/SKILL.md']
}));
`;
        const previousCapture = process.env.XTRM_RENDER_CAPTURE;
        const previousFail = process.env.XTRM_RENDER_FAIL;
        process.env.XTRM_RENDER_CAPTURE = capture;
        process.env.XTRM_RENDER_FAIL = fail ? '1' : '0';
        try {
            withFakeSp(script, run);
        } finally {
            process.env.XTRM_RENDER_CAPTURE = previousCapture;
            process.env.XTRM_RENDER_FAIL = previousFail;
            rmSync(capture, { force: true });
        }
    }

    it('calls the specialists renderer in the original cwd and preserves prompt bytes', () => {
        withRenderTaskSp(false, () => {
            const result = renderRoleTask({
                role: 'chain-coordinator',
                bead: 'xtrm-k2ufi',
                cwd: os.tmpdir(),
                runtime: 'claude',
            });
            expect(result.initialPrompt).toBe("line one\n$vars and 'quotes' survive");
            expect(result.promptHash).toBe('0123456789abcdef');
            const invocation = JSON.parse(readFileSync(capture, 'utf8'));
            expect(invocation.cwd).toBe(os.tmpdir());
            expect(invocation.argv).toEqual([
                'render-task', 'chain-coordinator', '--bead', 'xtrm-k2ufi',
                '--cwd', os.tmpdir(), '--context-depth', '3', '--surface', 'claude',
            ]);
        });
    });

    it('surfaces stable renderer failures before provisioning', () => {
        withRenderTaskSp(true, () => {
            expect(() => renderRoleTask({
                role: 'chain-coordinator', bead: 'missing', cwd: os.tmpdir(), runtime: 'pi',
            })).toThrow(/bead_not_found.*missing bead/);
        });
    });
});

describe('probeSkillPrefixAvailable', () => {
    it('returns ok when sp supports render-skill-prefix', () => {
        const script = `#!/usr/bin/env node
process.stdout.write("Usage: sp render-skill-prefix <name> --surface pi|claude");
process.exit(0);
`;
        withFakeSp(script, () => {
            expect(probeSkillPrefixAvailable()).toEqual({ ok: true });
        });
    });

    it('returns actionable upgrade hint when the command is missing', () => {
        const script = `#!/usr/bin/env node
process.stderr.write("error: unknown command 'render-skill-prefix'");
process.exit(1);
`;
        withFakeSp(script, () => {
            const result = probeSkillPrefixAvailable();
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('sp render-skill-prefix not available');
                expect(result.error).toContain('@jaggerxtrm/specialists@latest');
            }
        });
    });
});

describe('renderSkillPrefix', () => {
    it('parses skill_prefix out of a success envelope', () => {
        const script = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, skill_prefix: '/skill:multiplexing /skill:pr-reviewer\\n\\n' }));
`;
        withFakeSp(script, () => {
            expect(renderSkillPrefix({ role: 'reviewer', runtime: 'pi' }).skillPrefix)
                .toBe('/skill:multiplexing /skill:pr-reviewer\n\n');
        });
    });

    it('returns empty string when the specialist declares no skills', () => {
        const script = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: true, skill_prefix: '' }));
`;
        withFakeSp(script, () => {
            expect(renderSkillPrefix({ role: 'blank', runtime: 'claude' }).skillPrefix).toBe('');
        });
    });

    it('throws on structured error payload', () => {
        const script = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no such specialist' } }));
process.exit(1);
`;
        withFakeSp(script, () => {
            expect(() => renderSkillPrefix({ role: 'ghost', runtime: 'pi' }))
                .toThrow(/not_found.*no such specialist/);
        });
    });

    it('throws on invalid JSON', () => {
        const script = `#!/usr/bin/env node
process.stdout.write("not json");
`;
        withFakeSp(script, () => {
            expect(() => renderSkillPrefix({ role: 'x', runtime: 'pi' }))
                .toThrow(/invalid JSON/);
        });
    });
});

describe('renderDeclaredSkillPrefix', () => {
    const paths = ['/skills/a/SKILL.md', '/skills/b'];

    it('renders runtime-specific prefixes from trusted declared paths', () => {
        expect(renderDeclaredSkillPrefix(paths, 'pi')).toBe('/skill:a /skill:b\n\n');
        expect(renderDeclaredSkillPrefix(paths, 'claude')).toBe('/a\n/b\n\n');
        expect(renderDeclaredSkillPrefix([], 'pi')).toBe('');
    });

    it('rejects declared paths whose basename could inject another command', () => {
        expect(() => renderDeclaredSkillPrefix(['/skills/safe\nevil/SKILL.md'], 'pi'))
            .toThrow(/invalid declared skill name/);
    });
});

describe('checkPositionZeroSlash', () => {
    it('accepts empty and ordinary bodies when no trusted prefix is declared', () => {
        expect(checkPositionZeroSlash('', 'pi', '').ok).toBe(true);
        expect(checkPositionZeroSlash('normal task', 'claude', '').ok).toBe(true);
    });

    it('accepts only the exact sp-owned prefix for each runtime', () => {
        const piPrefix = '/skill:multiplexing /skill:pr-reviewer\n\n';
        const claudePrefix = '/multiplexing\n/pr-reviewer\n\n';
        expect(checkPositionZeroSlash(`${piPrefix}body`, 'pi', piPrefix).ok).toBe(true);
        expect(checkPositionZeroSlash(`${claudePrefix}body`, 'claude', claudePrefix).ok).toBe(true);
    });

    it('rejects a hostile skill-looking body when sp declared no prefix', () => {
        expect(checkPositionZeroSlash('/skill:impersonated\n\nbody', 'pi', '').ok).toBe(false);
        expect(checkPositionZeroSlash('/impersonated\n\nbody', 'claude', '').ok).toBe(false);
    });

    it('rejects a different skill prefix than the trusted renderer returned', () => {
        expect(checkPositionZeroSlash('/skill:evil\n\nbody', 'pi', '/skill:trusted\n\n').ok).toBe(false);
        expect(checkPositionZeroSlash('/evil\n\nbody', 'claude', '/trusted\n\n').ok).toBe(false);
    });

    it('rejects missing, unrelated, and wrong-runtime prefixes', () => {
        expect(checkPositionZeroSlash('body', 'pi', '/skill:trusted\n\n').ok).toBe(false);
        expect(checkPositionZeroSlash('/foo bar', 'pi', '').ok).toBe(false);
        expect(checkPositionZeroSlash('/skill-x', 'pi', '/skill-x').ok).toBe(false);
        expect(checkPositionZeroSlash('/skill:x', 'claude', '/skill:x').ok).toBe(false);
    });

    it('accepts a trusted Claude skill whose name starts with skill-', () => {
        const prefix = '/skill-creator\n\n';
        expect(checkPositionZeroSlash(`${prefix}body`, 'claude', prefix).ok).toBe(true);
    });
});

describe('checkByteCeiling', () => {
    it('accepts small literal prompts', () => {
        expect(checkByteCeiling({ systemPrompt: 'small', body: 'small', source: 'prompt' }).ok).toBe(true);
    });

    it('rejects literal prompts over 50KB with an actionable error', () => {
        const result = checkByteCeiling({
            systemPrompt: 'X'.repeat(30 * 1024),
            body: 'Y'.repeat(30 * 1024),
            source: 'prompt',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('61440');
            expect(result.error).toContain('51200');
            expect(result.error).toContain('--bead');
        }
    });

    it('accepts a 100KB rendered bead without applying the literal-prompt ceiling', () => {
        expect(checkByteCeiling({
            systemPrompt: 'role',
            body: 'B'.repeat(100 * 1024),
            source: 'bead',
        }).ok).toBe(true);
    });

    it('rejects a rendered bead that exceeds one safe runtime argument', () => {
        const result = checkByteCeiling({
            systemPrompt: 'role',
            body: 'B'.repeat(128 * 1024),
            source: 'bead',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('runtime argument ceiling');
    });

    it('rejects NUL bytes before spawning a runtime', () => {
        const result = checkByteCeiling({ systemPrompt: 'role', body: 'a\0b', source: 'bead' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('NUL');
    });
});

describe('role command flags', () => {
    it.each([
        ['pi', createPiCommand],
        ['claude', createClaudeCommand],
    ] as const)('documents repeatable --skill for xt %s', (_runtime, createCommand) => {
        const command = createCommand();
        const help = command.helpInformation();
        expect(help).toContain('--skill <name-or-path>');
        expect(help).toContain('repeatable');
        command.parseOptions(['--role', 'reviewer', '--skill', 'one', '--skill', 'two']);
        expect(command.opts().skill).toEqual(['one', 'two']);

        const passthroughCommand = createCommand().exitOverride().action(() => undefined);
        expect(() => passthroughCommand.parse([
            'node', 'xt', 'session', '--role', 'reviewer', '--', '--no-tools',
        ])).not.toThrow();
    });

    it.each([
        ['pi', createPiCommand],
        ['claude', createClaudeCommand],
    ] as const)('documents --prompt on xt %s', (_runtime, createCommand) => {
        const command = createCommand();
        const help = command.helpInformation();
        expect(help).toContain('--prompt <text>');
        // commander may wrap 'mutually\n  exclusive' — match tolerant of whitespace
        expect(help).toMatch(/mutually\s+exclusive/);
        command.parseOptions(['--role', 'reviewer', '--prompt', 'do the thing']);
        expect(command.opts().prompt).toBe('do the thing');
    });
});

describe('resolveRole surface model contract', () => {
    // resolveRole now spawns sp with cwd=mainRepoRoot (SEC-01), so the fake
    // root must be a real directory.
    const fakeRepoRoot = path.join(os.tmpdir(), `xtrm-role-repo-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const capture = path.join(os.tmpdir(), `xtrm-role-view-capture-${process.pid}`);

    beforeAll(() => mkdirSync(fakeRepoRoot, { recursive: true }));
    afterAll(() => rmSync(fakeRepoRoot, { recursive: true, force: true }));
    afterEach(() => rmSync(capture, { force: true }));

    it('requests Claude surface resolution and leaves a null role model unset', () => {
        const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.XTRM_ROLE_VIEW_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ specialist: { prompt: { system: 'role' }, execution: { model: null } } }));
`;
        const previousCapture = process.env.XTRM_ROLE_VIEW_CAPTURE;
        process.env.XTRM_ROLE_VIEW_CAPTURE = capture;
        try {
            withFakeSp(script, () => {
                const role = resolveRole('chain-coordinator', fakeRepoRoot, 'claude');
                expect(role.model).toBeUndefined();
            });
            expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
                'view', 'chain-coordinator', '--raw', '--surface', 'claude',
            ]);
        } finally {
            process.env.XTRM_ROLE_VIEW_CAPTURE = previousCapture;
        }
    });

    it('keeps Pi legacy resolution when an older Specialists lacks --surface', () => {
        const script = `#!/usr/bin/env node
if (process.argv.includes('--surface')) {
  process.stderr.write("unknown option '--surface'");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ specialist: { prompt: { system: 'role' }, execution: { model: 'openai-codex/gpt-5.6-luna' } } }));
`;
        withFakeSp(script, () => {
            const role = resolveRole('chain-coordinator', fakeRepoRoot, 'pi');
            expect(role.model).toBe('openai-codex/gpt-5.6-luna');
        });
    });

    it('fails clearly instead of falling back for old Claude Specialists', () => {
        const script = `#!/usr/bin/env node
process.stderr.write("unknown option '--surface'");
process.exit(1);
`;
        withFakeSp(script, () => {
            expect(() => resolveRole('chain-coordinator', fakeRepoRoot, 'claude'))
                .toThrow(/surface-aware Claude model resolution.*upgrade/);
        });
    });

    it('allows an explicit Claude model to use legacy Specialists resolution and pins the sp cwd (751b)', () => {
        const cwdCapture = path.join(os.tmpdir(), `xtrm-legacy-cwd-${process.pid}`);
        const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.XTRM_LEGACY_CWD, process.cwd());
if (process.argv.includes('--surface')) {
  process.stderr.write("unknown option '--surface'");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ specialist: { prompt: { system: 'role' }, execution: { model: 'openai-codex/gpt-5.6-luna' } } }));
`;
        const previousCapture = process.env.XTRM_LEGACY_CWD;
        process.env.XTRM_LEGACY_CWD = cwdCapture;
        try {
            withFakeSp(script, () => {
                const role = resolveRole('chain-coordinator', fakeRepoRoot, 'claude', true);
                expect(role.model).toBe('openai-codex/gpt-5.6-luna');
                // The legacy fallback spawn must run with cwd=mainRepoRoot so
                // repo-local specs resolve from a subdirectory launch.
                expect(path.normalize(readFileSync(cwdCapture, 'utf8'))).toBe(path.normalize(fakeRepoRoot));
            });
        } finally {
            process.env.XTRM_LEGACY_CWD = previousCapture;
            rmSync(cwdCapture, { force: true });
        }
    });
});

describe('parseSpecialistJson', () => {
    const mainRepoRoot = '/repo/root';

    it('extracts system prompt + skill paths verbatim (resolution is deferred)', () => {
        const role = parseSpecialistJson('chain-coordinator', SAMPLE_SPECIALIST, mainRepoRoot);
        expect(role.name).toBe('chain-coordinator');
        expect(role.systemPrompt).toContain('chain coordinator');
        // Declared paths stay raw; resolveRequestedSkills resolves them at
        // launch (xtrm-lk07w.14 — bare names must reach pack discovery).
        expect(role.skillPaths).toEqual([
            '.xtrm/skills/test-only/synthetic-a/SKILL.md',
            '.xtrm/skills/test-only/synthetic-b/SKILL.md',
        ]);
    });

    it('keeps relative skill path raw for launch-time resolution', () => {
        const role = parseSpecialistJson('x', JSON.stringify({
            specialist: {
                prompt: { system: 'hi' },
                skills: { paths: ['skills/demo/SKILL.md'] },
            },
        }), mainRepoRoot);
        expect(role.skillPaths).toEqual(['skills/demo/SKILL.md']);
    });

    it('preserves absolute skill path unchanged', () => {
        const absoluteSkillPath = '/abs/skill/SKILL.md';
        const role = parseSpecialistJson('x', JSON.stringify({
            specialist: {
                prompt: { system: 'hi' },
                skills: { paths: [absoluteSkillPath] },
            },
        }), mainRepoRoot);
        expect(role.skillPaths).toEqual([absoluteSkillPath]);
    });

    it('keeps tilde skill path raw for launch-time expansion', () => {
        const role = parseSpecialistJson('x', JSON.stringify({
            specialist: {
                prompt: { system: 'hi' },
                skills: { paths: ['~/team/skill/SKILL.md'] },
            },
        }), mainRepoRoot);
        expect(role.skillPaths).toEqual(['~/team/skill/SKILL.md']);
    });

    it('throws on missing specialist key', () => {
        expect(() => parseSpecialistJson('x', '{}', mainRepoRoot)).toThrow(/missing 'specialist' key/);
    });

    it('throws on empty system prompt', () => {
        const bad = JSON.stringify({ specialist: { prompt: { system: '   ' } } });
        expect(() => parseSpecialistJson('x', bad, mainRepoRoot)).toThrow(/prompt.system is empty/);
    });

    it('throws on non-JSON input', () => {
        expect(() => parseSpecialistJson('x', 'not-json', mainRepoRoot)).toThrow(/did not return JSON/);
    });

    it('tolerates missing skills section (returns empty array)', () => {
        const minimal = JSON.stringify({
            specialist: { prompt: { system: 'hi' } },
        });
        const role = parseSpecialistJson('minimal', minimal, mainRepoRoot);
        expect(role.skillPaths).toEqual([]);
    });

    it('filters non-string skill paths', () => {
        const messy = JSON.stringify({
            specialist: {
                prompt: { system: 'hi' },
                skills: { paths: ['a.md', 42, null, 'b.md'] },
            },
        });
        const role = parseSpecialistJson('messy', messy, mainRepoRoot);
        expect(role.skillPaths).toEqual(['a.md', 'b.md']);
    });

    it('honors system_prompt_mode=replace by warning and returning prompt anyway', () => {
        const replaceMode = JSON.stringify({
            specialist: {
                prompt: { system: 'ignore-base' },
                system_prompt_mode: 'replace',
            },
        });
        const role = parseSpecialistJson('replacer', replaceMode, mainRepoRoot);
        expect(role.systemPrompt).toBe('ignore-base');
    });
});

describe('buildBareTmuxPlan', () => {
    it('forwards prompt and model to Claude without role metadata', () => {
        const plan = buildBareTmuxPlan({ ...WT,
            runtime: 'claude',
            sessionSlug: 'demo',
            parentSessionId: '',
            turn1Body: 'echo hi',
            modelOverride: 'claude-opus-4-8',
            thinkingOverride: 'high',
        });

        expect(plan.sessionName).toBe('claude-demo');
        expect(plan.runtimeArgs).toEqual([
            '--name', WT.sessionDisplayName,
            '--dangerously-skip-permissions',
            '--model', 'claude-opus-4-8',
            '--', 'echo hi',
        ]);
    });

    it('emits no --append-system-prompt and no --no-skills for pi', () => {
        const plan = buildBareTmuxPlan({ ...WT,
            runtime: 'pi',
            sessionSlug: 'demo',
            parentSessionId: '',
            turn1Body: 'hi',
            thinkingOverride: 'high',
        });

        expect(plan.sessionName).toBe('pi-demo');
        expect(plan.runtimeArgs).not.toContain('--append-system-prompt');
        expect(plan.runtimeArgs).not.toContain('--no-skills');
        // pi takes the positional without a `--` delimiter.
        expect(plan.runtimeArgs).toEqual(['--name', WT.sessionDisplayName, '--thinking', 'high', 'hi']);
    });

    it('pushes explicit --skill paths to pi argv (bare mode)', () => {
        const plan = buildBareTmuxPlan({ ...WT,
            runtime: 'pi',
            sessionSlug: 'demo',
            parentSessionId: '',
            turn1Body: '',
            explicitSkillPaths: ['/skills/multiplexing', '/skills/multiplexing', '/skills/planning'],
        });

        // Deduped, order preserved, no turn-1 positional when the body is empty.
        expect(plan.runtimeArgs).toEqual([
            '--name', WT.sessionDisplayName,
            '--skill', '/skills/multiplexing',
            '--skill', '/skills/planning',
        ]);
    });

    it('binds --bead as pane + session metadata without touching the session name', () => {
        const plan = buildBareTmuxPlan({ ...WT,
            runtime: 'claude',
            sessionSlug: 'demo',
            bead: 'xtrm-3xgs5',
            parentSessionId: '$7',
            turn1Body: 'hi',
        });

        // Bare session identity is the slug alone — the bead does not enter it.
        expect(plan.sessionName).toBe('claude-demo');
        expect(plan.paneOptions).toEqual([
            { key: '@agent_parent_session', value: '$7' },
            { key: '@agent_task', value: 'session:demo' },
            { key: '@agent_state', value: 'idle' },
            { key: '@agent_worktree', value: WT.worktreePath },
            { key: '@agent_branch', value: WT.branchName },
            { key: '@agent_bead', value: 'xtrm-3xgs5' },
        ]);
        // A bare session has no role to publish.
        expect(plan.paneOptions.some((o) => o.key === '@agent_role')).toBe(false);
    });

    it('appends guard-checked passthrough before the turn-1 positional', () => {
        const plan = buildBareTmuxPlan({ ...WT,
            runtime: 'claude',
            sessionSlug: 'demo',
            parentSessionId: '',
            turn1Body: 'hi',
            passthrough: ['--add-dir', '/notes'],
        });

        expect(plan.runtimeArgs).toEqual([
            '--name', WT.sessionDisplayName,
            '--dangerously-skip-permissions',
            '--add-dir', '/notes',
            '--', 'hi',
        ]);
    });

    // XTRM-249. The flag must land before the `--` delimiter, or claude reads
    // the entry as the positional prompt. `channels` is a decision handed in by
    // the launcher, so the builder stays hermetic: no $HOME read, no flag.
    it('emits --channels before the turn-1 delimiter when the launcher enables it', () => {
        const plan = buildBareTmuxPlan({ ...WT,
            runtime: 'claude',
            sessionSlug: 'demo',
            parentSessionId: '',
            turn1Body: 'hi',
            channels: true,
        });

        expect(plan.runtimeArgs).toEqual([
            '--name', WT.sessionDisplayName,
            '--dangerously-skip-permissions',
            '--channels', 'plugin:specialists@xtrm',
            '--', 'hi',
        ]);
    });

    it('omits --channels when the launcher did not enable it, and always for pi', () => {
        const off = buildBareTmuxPlan({ ...WT,
            runtime: 'claude', sessionSlug: 'demo', parentSessionId: '', turn1Body: 'hi',
        });
        expect(off.runtimeArgs).not.toContain('--channels');

        // pi has no --channels flag; passing the decision through must not
        // produce one. Fail-soft is the whole contract here (XTRM-249).
        const pi = buildBareTmuxPlan({ ...WT,
            runtime: 'pi', sessionSlug: 'demo', parentSessionId: '', turn1Body: 'hi',
            channels: true,
        });
        expect(pi.runtimeArgs).not.toContain('--channels');
    });
});

describe('buildRoleTmuxPlan (pi runtime)', () => {
    const role = parseSpecialistJson('chain-coordinator', SAMPLE_SPECIALIST);

    it('inlines system prompt and emits --no-skills unconditionally', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            bead: 'xtmux-2i5',
            parentSessionId: '$3',
            turn1Body: '/skill:a /skill:b\n\ntask body',
        });
        expect(plan.sessionName).toBe('role-pi-chain-coordinator-xtmux-2i5');
        // Launcher-owned --name is first; inline system prompt follows.
        expect(plan.runtimeArgs[0]).toBe('--name');
        expect(plan.runtimeArgs[1]).toBe(WT.sessionDisplayName);
        expect(plan.runtimeArgs[2]).toBe('--append-system-prompt');
        expect(plan.runtimeArgs[3]).toContain('chain coordinator');
        expect(plan.runtimeArgs).toContain('--no-skills');
        // Pool isolation combined with explicit skills from role
        expect(plan.runtimeArgs.filter((a) => a === '--skill')).toHaveLength(2);
        // Turn-1 body is the last positional (pi convention: no `--` delimiter)
        expect(plan.runtimeArgs.at(-1)).toBe('/skill:a /skill:b\n\ntask body');
        expect(plan.runtimeArgs).not.toContain('--');
        const bead = plan.paneOptions.find((o) => o.key === '@agent_bead');
        expect(bead?.value).toBe('xtmux-2i5');
        const task = plan.paneOptions.find((o) => o.key === '@agent_task');
        expect(task?.value).toBe('role:chain-coordinator');
        const parent = plan.paneOptions.find((o) => o.key === '@agent_parent_session');
        expect(parent?.value).toBe('$3');
        const state = plan.paneOptions.find((o) => o.key === '@agent_state');
        expect(state?.value).toBe('idle');
        // xtrm-8zsi1: no more prompt-file transport
        expect(plan.paneOptions.some((o) => o.key === '@agent_prompt_file')).toBe(false);
        // xtrm-6hey0.2: lineage the P1-02 invariant guarantees but nothing
        // downstream could observe before.
        const worktree = plan.paneOptions.find((o) => o.key === '@agent_worktree');
        expect(worktree?.value).toBe(WT.worktreePath);
        const branch = plan.paneOptions.find((o) => o.key === '@agent_branch');
        expect(branch?.value).toBe(WT.branchName);
        const roleOption = plan.paneOptions.find((o) => o.key === '@agent_role');
        expect(roleOption?.value).toBe('chain-coordinator');
    });

    it('omits @agent_bead and bead-slug when bead is not provided', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '',
            turn1Body: '',
        });
        expect(plan.sessionName).toBe('role-pi-chain-coordinator');
        expect(plan.paneOptions.some((o) => o.key === '@agent_bead')).toBe(false);
        const parent = plan.paneOptions.find((o) => o.key === '@agent_parent_session');
        expect(parent?.value).toBe('');
    });

    it('omits positional when turn1Body is empty (skills-only prime)', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '',
            turn1Body: '',
        });
        // No trailing positional at all
        expect(plan.runtimeArgs.every((a) => a.startsWith('--') || plan.runtimeArgs.indexOf(a) === plan.runtimeArgs.indexOf('--append-system-prompt') + 1 || plan.runtimeArgs.indexOf(a) > 0)).toBe(true);
        expect(plan.runtimeArgs).not.toContain('');
    });

    it('shell-quotes the pi command string including single quotes in body', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '',
            turn1Body: "hello it's mine",
        });
        expect(plan.runtimeCmdString.startsWith("'pi' '--name' ")).toBe(true);
        expect(plan.runtimeCmdString).toContain("'hello it'\\''s mine'");
    });

    it('encodes runtime in the session name so pi/claude do not collide (xtmux-3h8)', () => {
        const piPlan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            bead: 'xtmux-3h8',
            parentSessionId: '',
            turn1Body: '',
        });
        const claudePlan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            bead: 'xtmux-3h8',
            parentSessionId: '',
            turn1Body: '',
        });
        expect(piPlan.sessionName).toBe('role-pi-chain-coordinator-xtmux-3h8');
        expect(claudePlan.sessionName).toBe('role-claude-chain-coordinator-xtmux-3h8');
    });

    it('slugifies bead ids with weird characters', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            bead: 'MY BEAD/1',
            parentSessionId: '',
            turn1Body: '',
        });
        expect(plan.sessionName).toBe('role-pi-chain-coordinator-my-bead-1');
    });

    it('does not emit --no-extensions or -e — pi discovers its own extensions', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '',
            turn1Body: '',
        });
        expect(plan.runtimeArgs).not.toContain('--no-extensions');
        expect(plan.runtimeArgs).not.toContain('-e');
    });

    it('keeps the Pi surface-resolved provider model unchanged', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role: { ...role, model: 'openai-codex/gpt-5.6-luna' },
            parentSessionId: '',
            turn1Body: '',
        });
        const modelIdx = plan.runtimeArgs.indexOf('--model');
        expect(plan.runtimeArgs[modelIdx + 1]).toBe('openai-codex/gpt-5.6-luna');
    });

    it('forwards --model / --thinking CLI overrides', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '',
            turn1Body: '',
            modelOverride: 'gemini/gemini-3-pro',
            thinkingOverride: 'high',
        });
        const modelIdx = plan.runtimeArgs.indexOf('--model');
        expect(plan.runtimeArgs[modelIdx + 1]).toBe('gemini/gemini-3-pro');
        const thinkIdx = plan.runtimeArgs.indexOf('--thinking');
        expect(plan.runtimeArgs[thinkIdx + 1]).toBe('high');
    });

    it('appends passthrough argv verbatim after all other flags', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '',
            turn1Body: 'body',
            passthrough: ['--gitnexus-cmd', 'foo bar'],
        });
        const idx = plan.runtimeArgs.indexOf('--gitnexus-cmd');
        expect(plan.runtimeArgs[idx + 1]).toBe('foo bar');
        // passthrough sits before the positional body
        expect(plan.runtimeArgs.at(-1)).toBe('body');
    });

    it('deduplicates explicit skills against declared skills (symlink aware)', () => {
        const sandbox = path.join(os.tmpdir(), `xtrm-plan-skill-${process.pid}`);
        const skillRoot = path.join(sandbox, 'skill');
        const aliasRoot = path.join(sandbox, 'alias');
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(skillRoot, { recursive: true });
        writeFileSync(path.join(skillRoot, 'SKILL.md'), '# skill');
        symlinkSync(skillRoot, aliasRoot, 'dir');
        try {
            const plan = buildRoleTmuxPlan({ ...WT,
                runtime: 'pi',
                role: { ...role, skillPaths: [path.join(aliasRoot, 'SKILL.md')] },
                explicitSkillPaths: [path.join(skillRoot, 'SKILL.md')],
                parentSessionId: '',
                turn1Body: '',
            });
            expect(plan.runtimeArgs.filter((arg) => arg === '--skill')).toHaveLength(1);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('CLI --model wins over specialist.execution.model', () => {
        const roleWithModel = parseSpecialistJson('withmodel', JSON.stringify({
            specialist: {
                prompt: { system: 'x' },
                execution: { model: 'default-model', thinking_level: 'medium' },
            },
        }));
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'pi',
            role: roleWithModel,
            parentSessionId: '',
            turn1Body: '',
            modelOverride: 'override-model',
        });
        const modelIdx = plan.runtimeArgs.indexOf('--model');
        expect(plan.runtimeArgs[modelIdx + 1]).toBe('override-model');
        const thinkIdx = plan.runtimeArgs.indexOf('--thinking');
        expect(plan.runtimeArgs[thinkIdx + 1]).toBe('medium');
    });
});

describe('isForeignProviderModel', () => {
    it.each([
        'qwencloud/qwen3.8-max-preview', 'openai-codex/gpt-5.4', 'gemini/gemini-3-pro',
        'Qwen-CLI/qwen3-coder', 'zai-coding-cn/glm-5', 'nano-gpt/moonshotai/kimi-k2.6',
        // Outer provider decides — a nested anthropic model is still an
        // OpenRouter id claude cannot run (Codex P1 on PR #511).
        'openrouter/anthropic/claude-sonnet-4.6',
    ])('flags the pi provider/model shape: %s', (model) => {
        expect(isForeignProviderModel(model)).toBe(true);
    });

    it.each([
        // Claude ids, aliases and vendor forms.
        'opus', 'sonnet[1m]', 'claude-opus-5', 'claude-opus-4-1@20250805',
        'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        // Bedrock application-inference-profile ARN — a valid --model with no
        // 'claude' in it. Must never be refused (Codex P1 on PR #511).
        'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123',
        // Custom / unrecognised gateways stay the operator's call, slash or not
        // (docs/xt-pi-role.md: explicit custom-provider identifiers win).
        'anthropic/claude-sonnet-5', 'acme/production', 'my-custom-model', '', '   ',
        // Vendor-prefixed gateway names are not the vendor (Codex P2 on PR #511).
        'openai-compatible/production', 'google-proxy/claude',
    ])('leaves %s alone', (model) => {
        expect(isForeignProviderModel(model)).toBe(false);
    });
});

describe('passthroughModels', () => {
    it.each([
        [['--model', 'qwencloud/qwen3.8-max-preview'], ['qwencloud/qwen3.8-max-preview']],
        [['--add-dir', '~/n', '--model=opus'], ['opus']],
        [['--add-dir', '~/notes'], []],
        [['--model'], []],
        // Every occurrence, not the first: the tail is forwarded verbatim, so a
        // later value wins at the runtime (Codex P2 on PR #511).
        [['--model', 'opus', '--model=qwencloud/qwen3.8-max-preview'], ['opus', 'qwencloud/qwen3.8-max-preview']],
        // After the operator's own `--`, `--model` is positional text.
        [['--', '--model', 'qwencloud/qwen3.8-max-preview'], []],
    ])('reads %s', (passthrough, expected) => {
        expect(passthroughModels(passthrough as string[])).toEqual(expected);
    });
});

// Last --model wins at the runtime; only that one is worth validating.
describe('effectiveModel', () => {
    it.each([
        [undefined, [], undefined],
        ['opus', [], 'opus'],
        [undefined, ['--model', 'opus'], 'opus'],
        // Tail overrides the native flag (Codex P2: safe native must not mask it).
        ['opus', ['--model', 'qwencloud/qwen3.8-max-preview'], 'qwencloud/qwen3.8-max-preview'],
        // ...and an overridden foreign value must not block a valid launch.
        [undefined, ['--model', 'qwencloud/qwen3.8-max-preview', '--model', 'opus'], 'opus'],
    ])('resolves (%s, %s)', (model, passthrough, expected) => {
        expect(effectiveModel(model as string | undefined, passthrough as string[])).toBe(expected);
    });
});

describe('buildRoleTmuxPlan (claude runtime)', () => {
    const role = parseSpecialistJson('chain-coordinator', JSON.stringify({
        specialist: {
            prompt: { system: 'You are chain-coordinator.' },
            skills: { paths: ['.xtrm/skills/x/SKILL.md'] },
            execution: { model: 'claude-opus-4-8', thinking_level: 'medium' },
        },
    }));

    it('inlines --append-system-prompt (xtrm-8zsi1 supersedes xtrm-osipt file transport)', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '$3',
            turn1Body: '/x\n\nbody',
        });
        expect(plan.runtimeCmd).toBe('claude');
        expect(plan.runtimeArgs[0]).toBe('--name');
        expect(plan.runtimeArgs[1]).toBe(WT.sessionDisplayName);
        expect(plan.runtimeArgs[2]).toBe('--append-system-prompt');
        expect(plan.runtimeArgs[3]).toBe('You are chain-coordinator.');
        expect(plan.runtimeArgs).not.toContain('--append-system-prompt-file');
        expect(plan.runtimeArgs).toContain('--dangerously-skip-permissions');
    });

    it('emits `--` before positional turn-1 body (claude variadic-flag safety)', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '',
            turn1Body: '/x\n\nbody',
        });
        expect(plan.runtimeArgs.slice(-2)).toEqual(['--', '/x\n\nbody']);
    });

    it('omits `--` and positional when turn1Body is empty (skills-only prime)', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '',
            turn1Body: '',
        });
        expect(plan.runtimeArgs).not.toContain('--');
        expect(plan.runtimeArgs.at(-1)).not.toBe('');
    });

    it('emits NO --skill and NO --plugin-dir on claude (xtrm-8zsi1 drops ephemeral plugin)', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '',
            turn1Body: 'x',
            explicitSkillPaths: ['/some/skill/SKILL.md'],
        });
        expect(plan.runtimeArgs).not.toContain('--skill');
        expect(plan.runtimeArgs).not.toContain('--plugin-dir');
    });

    it('preserves an explicit Claude model override over a cross-provider role default', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role: { ...role, model: 'openai-codex/gpt-5.6-luna' },
            parentSessionId: '',
            turn1Body: '',
            modelOverride: 'opus',
            thinkingOverride: 'high',
        });
        const modelIdx = plan.runtimeArgs.indexOf('--model');
        expect(plan.runtimeArgs[modelIdx + 1]).toBe('opus');
        expect(plan.runtimeArgs).not.toContain('openai-codex/gpt-5.6-luna');
        expect(plan.runtimeArgs).not.toContain('--thinking');
    });

    // xtrm-wiy5n.4.19: sp view --surface claude falls back to the pi-surface
    // execution.model when no surface_models.claude is declared, so a role
    // default like qwencloud/… reaches the launcher. Forwarding it spawned a
    // live session that died at turn 1.
    it('drops a cross-provider role default so claude inherits the parent model', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role: { ...role, model: 'qwencloud/qwen3.8-max-preview' },
            parentSessionId: '',
            turn1Body: '',
        });
        expect(plan.runtimeArgs).not.toContain('--model');
        expect(plan.runtimeArgs).not.toContain('qwencloud/qwen3.8-max-preview');
    });

    it('keeps a Bedrock inference-profile ARN role default', () => {
        const arn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123';
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role: { ...role, model: arn },
            parentSessionId: '',
            turn1Body: '',
        });
        const modelIdx = plan.runtimeArgs.indexOf('--model');
        expect(plan.runtimeArgs[modelIdx + 1]).toBe(arn);
    });

    it('keeps a Claude role default', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '',
            turn1Body: '',
        });
        const modelIdx = plan.runtimeArgs.indexOf('--model');
        expect(plan.runtimeArgs[modelIdx + 1]).toBe('claude-opus-4-8');
    });

    it('omits --model for a surface-resolved Claude default', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role: { ...role, model: undefined },
            parentSessionId: '',
            turn1Body: '',
        });
        expect(plan.runtimeArgs).not.toContain('--model');
    });

    it('shell-quotes with claude as the runtime prefix and inlines the system prompt safely', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '',
            turn1Body: '',
        });
        expect(plan.runtimeCmdString.startsWith("'claude' '--name' ")).toBe(true);
        expect(plan.runtimeCmdString).toContain("'You are chain-coordinator.'");
    });

    it('appends passthrough verbatim (before positional body)', () => {
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '',
            turn1Body: 'body',
            passthrough: ['--add-dir', '/notes'],
        });
        const idx = plan.runtimeArgs.indexOf('--add-dir');
        expect(plan.runtimeArgs[idx + 1]).toBe('/notes');
        // positional body is still last
        expect(plan.runtimeArgs.at(-1)).toBe('body');
    });

    it('keeps runtimeCmdString bounded when body is under the byte ceiling', () => {
        const almostFull = 'X'.repeat(40 * 1024);
        const plan = buildRoleTmuxPlan({ ...WT,
            runtime: 'claude',
            role,
            parentSessionId: '',
            turn1Body: almostFull,
        });
        // The 40KB body IS inline now (unlike the xtrm-osipt stopgap which
        // wrote it to a file). This is fine because launchWorktreeSession
        // enforces the byte ceiling before we ever reach here.
        expect(plan.runtimeCmdString.length).toBeGreaterThan(40 * 1024);
        expect(plan.runtimeCmdString.length).toBeLessThan(50 * 1024);
    });
});

describe('buildAgentEnv', () => {
    const role = parseSpecialistJson('chain-coordinator', SAMPLE_SPECIALIST);

    it('exports role + parent session id (no more XTMUX_AGENT_PROMPT_FILE)', () => {
        const env = buildAgentEnv(buildRoleTmuxPlan({
            ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '$5',
            turn1Body: '',
        }).paneOptions);
        expect(env.XTMUX_AGENT_TASK).toBe('role:chain-coordinator');
        expect(env.XTMUX_AGENT_PARENT_SESSION).toBe('$5');
        expect(env.XTMUX_AGENT_BEAD).toBeUndefined();
        expect(env.XTMUX_AGENT_PROMPT_FILE).toBeUndefined();
    });

    it('includes bead when provided', () => {
        const env = buildAgentEnv(buildRoleTmuxPlan({
            ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '',
            bead: 'xtmux-1lb.5',
            turn1Body: '',
        }).paneOptions);
        expect(env.XTMUX_AGENT_BEAD).toBe('xtmux-1lb.5');
    });

    // Env is derived from the pane options so the two can never drift; the
    // pair that used to be built by hand in two places is what this proves.
    it('mirrors every pane option except the launcher-local @agent_state', () => {
        const env = buildAgentEnv(buildRoleTmuxPlan({
            ...WT,
            runtime: 'pi',
            role,
            parentSessionId: '$5',
            bead: 'xtrm-6hey0',
            turn1Body: '',
        }).paneOptions);
        expect(env).toEqual({
            XTMUX_AGENT_PARENT_SESSION: '$5',
            XTMUX_AGENT_TASK: 'role:chain-coordinator',
            XTMUX_AGENT_WORKTREE: WT.worktreePath,
            XTMUX_AGENT_BRANCH: WT.branchName,
            XTMUX_AGENT_BEAD: 'xtrm-6hey0',
            XTMUX_AGENT_ROLE: 'chain-coordinator',
        });
        expect(env.XTMUX_AGENT_STATE).toBeUndefined();
    });

    it('omits XTMUX_AGENT_ROLE for a bare session', () => {
        const env = buildAgentEnv(buildBareTmuxPlan({
            ...WT,
            runtime: 'claude',
            sessionSlug: 'demo',
            parentSessionId: '$5',
            turn1Body: '',
        }).paneOptions);
        expect(env.XTMUX_AGENT_TASK).toBe('session:demo');
        expect(env.XTMUX_AGENT_ROLE).toBeUndefined();
        expect(env.XTMUX_AGENT_WORKTREE).toBe(WT.worktreePath);
        expect(env.XTMUX_AGENT_BRANCH).toBe(WT.branchName);
    });
});

describe('chooseAttachCommand', () => {
    it('uses switch-client inside an existing tmux client', () => {
        expect(chooseAttachCommand('role-x-y', true)).toEqual([
            'switch-client', '-t', 'role-x-y',
        ]);
    });

    it('uses attach-session outside tmux', () => {
        expect(chooseAttachCommand('role-x-y', false)).toEqual([
            'attach-session', '-t', 'role-x-y',
        ]);
    });
});

describe('guardRolePassthrough', () => {
    it('rejects xt-owned flags with a clear error', () => {
        const r = guardRolePassthrough(['--session-dir', '/x']);
        expect(r.guardedError).toMatch(/--session-dir/);
    });

    it('rejects --name= form', () => {
        const r = guardRolePassthrough(['--name=other']);
        expect(r.guardedError).toMatch(/--name/);
    });

    it('rejects passthrough --skill so validation cannot be bypassed', () => {
        const r = guardRolePassthrough(['--skill', 'missing']);
        expect(r.guardedError).toMatch(/--skill/);
    });

    it('warns-and-drops --print and consumes its value', () => {
        const r = guardRolePassthrough(['--print', 'once', '--foo', 'bar']);
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.filteredArgs).toEqual(['--foo', 'bar']);
    });

    it('warns-and-drops --list-models (boolean flag: no value to consume)', () => {
        const r = guardRolePassthrough(['--list-models', '--foo']);
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.filteredArgs).toEqual(['--foo']);
    });

    it('passes safe flags through verbatim', () => {
        const r = guardRolePassthrough(['--gitnexus-cmd', 'foo bar', '--verbose']);
        expect(r.guardedError).toBeUndefined();
        expect(r.filteredArgs).toEqual(['--gitnexus-cmd', 'foo bar', '--verbose']);
    });
});

describe('resolveRequestedSkills', () => {
    const sandbox = path.join(os.tmpdir(), `xtrm-requested-skills-${process.pid}`);
    const fakeHome = path.join(sandbox, 'home');
    const fakeRepo = path.join(sandbox, 'repo');

    it('resolves installed names and explicit paths, deduplicated in request order', () => {
        rmSync(sandbox, { recursive: true, force: true });
        const installed = path.join(fakeHome, '.pi', 'agent', 'skills', 'multiplexing', 'SKILL.md');
        const explicit = path.join(fakeRepo, 'skills', 'local', 'SKILL.md');
        mkdirSync(path.dirname(installed), { recursive: true });
        mkdirSync(path.dirname(explicit), { recursive: true });
        writeFileSync(installed, '# global');
        writeFileSync(explicit, '# local');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(resolveRequestedSkills(fakeRepo, ['multiplexing', explicit, 'multiplexing']))
                .toEqual([installed, explicit]);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('deduplicates symlink aliases of the same skill', () => {
        rmSync(sandbox, { recursive: true, force: true });
        const skill = path.join(fakeHome, '.xtrm', 'skills', 'default', 'multiplexing');
        const alias = path.join(fakeHome, '.pi', 'agent', 'skills', 'multiplexing');
        mkdirSync(skill, { recursive: true });
        mkdirSync(path.dirname(alias), { recursive: true });
        writeFileSync(path.join(skill, 'SKILL.md'), '# global');
        symlinkSync(skill, alias, 'dir');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(resolveRequestedSkills(fakeRepo, ['multiplexing', path.join(skill, 'SKILL.md')]))
                .toEqual([path.join(skill, 'SKILL.md')]);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('fails clearly when a requested skill is not installed', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeHome, { recursive: true });
        mkdirSync(fakeRepo, { recursive: true });
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => resolveRequestedSkills(fakeRepo, ['missing-skill']))
                .toThrow(/skill 'missing-skill' not found/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects an existing path that is not a skill before provisioning', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const notSkill = path.join(fakeRepo, 'README.md');
        writeFileSync(notSkill, '# not a skill');
        try {
            expect(() => resolveRequestedSkills(fakeRepo, [notSkill]))
                .toThrow(/not a skill/);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    // xtrm-lk07w.14: bare logical skill names resolve from v2 project packs
    // under <repo>/.xtrm/skills/<pack>/<skill>/SKILL.md before any global
    // fallback. Pack name is arbitrary — nothing in production logic may
    // hard-code 'infra' or 'service-knowledge'.
    function writePackSkill(packName: string, skillName: string): string {
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', packName, skillName);
        mkdirSync(skillDir, { recursive: true });
        const skillFile = path.join(skillDir, 'SKILL.md');
        writeFileSync(skillFile, `# ${packName}/${skillName}`);
        return skillFile;
    }

    it('resolves a bare name from a single project pack under .xtrm/skills', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const expected = writePackSkill('infra', 'service-knowledge');
        // A second pack that does not own the name must not interfere.
        writePackSkill('market-data', 'data-catalog');
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toEqual([expected]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('resolves the same bare name from an arbitrary second pack name', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const expected = writePackSkill('market-data', 'service-knowledge');
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toEqual([expected]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('resolves the project pack skill ahead of a same-named global default', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const expected = writePackSkill('infra', 'service-knowledge');
        const globalDefault = path.join(fakeHome, '.xtrm', 'skills', 'default', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(globalDefault), { recursive: true });
        writeFileSync(globalDefault, '# global');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toEqual([expected]);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('fails deterministically when two packs own the same skill name', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        writePackSkill('infra', 'service-knowledge');
        writePackSkill('market-data', 'service-knowledge');
        // A same-named global default must not mask the ambiguity.
        const globalDefault = path.join(fakeHome, '.xtrm', 'skills', 'default', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(globalDefault), { recursive: true });
        writeFileSync(globalDefault, '# global');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/service-knowledge.*ambiguous/);
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/\.xtrm\/skills\/infra\/service-knowledge/);
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/\.xtrm\/skills\/market-data\/service-knowledge/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('ignores reserved tier directories when scanning project packs', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        // 'default' and 'local-legacy' are reserved names, not packs: a skill
        // nested under them must not resolve as a project-pack match.
        const underDefault = path.join(fakeRepo, '.xtrm', 'skills', 'default', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(underDefault), { recursive: true });
        writeFileSync(underDefault, '# tier default');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/skill 'service-knowledge' not found/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('keeps an enabled repo runtime-view skill ahead of the pack source', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        writePackSkill('infra', 'service-knowledge');
        const enabled = path.join(fakeRepo, '.pi', 'skills', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(enabled), { recursive: true });
        writeFileSync(enabled, '# enabled');
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toEqual([enabled]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('enabled repo runtime-view wins before pack ambiguity is consulted', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        // Two packs own the name — normally a deterministic failure — but the
        // operator's explicit enablement resolves it first (claude runtime
        // sees its own .claude view only).
        writePackSkill('infra', 'service-knowledge');
        writePackSkill('market-data', 'service-knowledge');
        const enabled = path.join(fakeRepo, '.claude', 'skills', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(enabled), { recursive: true });
        writeFileSync(enabled, '# enabled');
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge'], 'claude'))
                .toEqual([enabled]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('resolves runtime-targeted repo views only (SEC-07: a claude launch never sees a pi view)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        // A Pi-only enabled view and a project pack carrying the same name.
        const piView = path.join(fakeRepo, '.pi', 'skills', 'quant', 'SKILL.md');
        mkdirSync(path.dirname(piView), { recursive: true });
        writeFileSync(piView, '# pi view');
        const packSkill = writePackSkill('market-data', 'quant');
        try {
            // pi runtime: its own enabled view wins.
            expect(resolveRequestedSkills(fakeRepo, ['quant'], 'pi')).toEqual([piView]);
            // claude runtime: the pi view is invisible; the pack wins.
            expect(resolveRequestedSkills(fakeRepo, ['quant'], 'claude')).toEqual([packSkill]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('resolves runtime-targeted home views only (SEC-07)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const piHome = path.join(fakeHome, '.pi', 'agent', 'skills', 'quant', 'SKILL.md');
        const claudeHome = path.join(fakeHome, '.claude', 'skills', 'quant', 'SKILL.md');
        mkdirSync(path.dirname(piHome), { recursive: true });
        mkdirSync(path.dirname(claudeHome), { recursive: true });
        writeFileSync(piHome, '# pi home');
        writeFileSync(claudeHome, '# claude home');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(resolveRequestedSkills(fakeRepo, ['quant'], 'pi')).toEqual([piHome]);
            expect(resolveRequestedSkills(fakeRepo, ['quant'], 'claude')).toEqual([claudeHome]);
            expect(() => resolveRequestedSkills(fakeRepo, ['quant'], 'codex')).toThrow(/not found/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('falls through to runtime-view and global defaults when no pack owns the name', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        // The pack scan is active (real packs exist) but none owns the name:
        // bare names must not become project-only.
        writePackSkill('infra', 'unrelated');
        const globalDefault = path.join(fakeHome, '.xtrm', 'skills', 'default', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(globalDefault), { recursive: true });
        writeFileSync(globalDefault, '# global');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toEqual([globalDefault]);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('resolves via canonical runtimeName even when the directory is renamed (SEC-NEW-02)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: service-knowledge\n---\n# renamed');
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toEqual([slotFile]);
            // The directory name also matches (dirname arm for consumer
            // layouts), but the BOUND claude name stays canonical.
            expect(resolveRequestedSkills(fakeRepo, ['catalog']))
                .toEqual([slotFile]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('resolves a pack-root SKILL.md by frontmatter name and by pack name', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const packDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra');
        mkdirSync(packDir, { recursive: true });
        const rootFile = path.join(packDir, 'SKILL.md');
        writeFileSync(rootFile, '---\nname: service-knowledge\n---\n# root');
        try {
            expect(resolveRequestedSkills(fakeRepo, ['service-knowledge'])).toEqual([rootFile]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('resolves a pack-root SKILL.md without frontmatter by pack name', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const packDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra');
        mkdirSync(packDir, { recursive: true });
        const rootFile = path.join(packDir, 'SKILL.md');
        writeFileSync(rootFile, '# root');
        try {
            expect(resolveRequestedSkills(fakeRepo, ['infra'])).toEqual([rootFile]);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('fails deterministically when two packs expose one runtime name (SEC-NEW-02)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        for (const pack of ['infra', 'market-data']) {
            const slotDir = path.join(fakeRepo, '.xtrm', 'skills', pack, 'catalog');
            mkdirSync(slotDir, { recursive: true });
            writeFileSync(path.join(slotDir, 'SKILL.md'), '---\nname: service-knowledge\n---\n# dup');
        }
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/ambiguous/);
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/\.xtrm\/skills\/infra\/catalog/);
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/\.xtrm\/skills\/market-data\/catalog/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects an unsafe frontmatter runtimeName on a dirname match (pi and claude)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        writeFileSync(path.join(slotDir, 'SKILL.md'), '---\nname: ../evil\n---\n# bad');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            for (const runtime of ['pi', 'claude', 'codex'] as const) {
                expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge'], runtime))
                    .toThrow(/unsafe runtime name/);
            }
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects a control-byte frontmatter runtimeName with escaped diagnostics', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: bad\u0007name\n---\n# bad');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            let msg = '';
            try { resolveRequestedSkills(fakeRepo, ['catalog'], 'pi'); } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            }
            expect(msg).toMatch(/unsafe runtime name/);
            expect(msg).toContain('\\u{07}');
            expect(msg).not.toContain('\u0007');
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});

describe('project-pack probe containment (xtrm-lk07w.14)', () => {
    const sandbox = path.join(os.tmpdir(), `xtrm-pack-probe-${process.pid}`);
    const fakeHome = path.join(sandbox, 'home');
    const fakeRepo = path.join(sandbox, 'repo');
    const external = path.join(sandbox, 'external');

    function setup(): void {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeHome, { recursive: true });
    }

    function writePack(packName: string, skillName: string): string {
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', packName, skillName);
        mkdirSync(skillDir, { recursive: true });
        const skillFile = path.join(skillDir, 'SKILL.md');
        writeFileSync(skillFile, `# ${packName}/${skillName}`);
        return skillFile;
    }

    function withHomeEnv(fn: () => void): void {
        const prev = process.env.HOME;
        process.env.HOME = fakeHome;
        try { fn(); } finally { process.env.HOME = prev; }
    }

    it('rejects a skill dir that is a symlink to outside the skills root', () => {
        setup();
        writePack('infra', 'service-knowledge');
        const externalSkillDir = path.join(external, 'skill-dir');
        mkdirSync(externalSkillDir, { recursive: true });
        writeFileSync(path.join(externalSkillDir, 'SKILL.md'), '# external');
        rmSync(path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge'), { recursive: true });
        symlinkSync(externalSkillDir, path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge'), 'dir');
        withHomeEnv(() => {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/is a symlink/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects a SKILL.md that is a symlink to an external file', () => {
        setup();
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(skillDir, { recursive: true });
        const externalFile = path.join(external, 'SKILL.md');
        mkdirSync(external, { recursive: true });
        writeFileSync(externalFile, '# external');
        symlinkSync(externalFile, path.join(skillDir, 'SKILL.md'), 'file');
        withHomeEnv(() => {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/not a regular file/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects a skills root that is a symlink escaping the consumer root', () => {
        setup();
        const externalSkills = path.join(external, 'skills');
        mkdirSync(path.join(externalSkills, 'infra', 'service-knowledge'), { recursive: true });
        writeFileSync(path.join(externalSkills, 'infra', 'service-knowledge', 'SKILL.md'), '# external');
        mkdirSync(path.join(fakeRepo, '.xtrm'), { recursive: true });
        symlinkSync(externalSkills, path.join(fakeRepo, '.xtrm', 'skills'), 'dir');
        withHomeEnv(() => {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/escapes the consumer checkout root/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('propagates an unreadable SKILL.md with a sanitized repo-relative message', () => {
        setup();
        const skillFile = writePack('infra', 'service-knowledge');
        chmodSync(skillFile, 0);
        try {
            withHomeEnv(() => {
                let msg = '';
                try { resolveRequestedSkills(fakeRepo, ['service-knowledge']); } catch (e) {
                    msg = e instanceof Error ? e.message : String(e);
                }
                expect(msg).toMatch(/project-pack skill 'infra\/service-knowledge\/SKILL\.md'/);
                // No absolute host paths leak into the message.
                expect(msg).not.toContain(sandbox);
            });
        } finally {
            chmodSync(skillFile, 0o644);
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects a SKILL.md that is a directory', () => {
        setup();
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(path.join(skillDir, 'SKILL.md'), { recursive: true });
        withHomeEnv(() => {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/not a regular file/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('throws when a requested-name skill dir exists without SKILL.md', () => {
        setup();
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(skillDir, { recursive: true });
        withHomeEnv(() => {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/has no SKILL\.md/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('throws when the requested-name skill slot is a non-directory file', () => {
        setup();
        const packDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra');
        mkdirSync(packDir, { recursive: true });
        writeFileSync(path.join(packDir, 'service-knowledge'), '# not a dir');
        withHomeEnv(() => {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/not a real directory/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('throws on a dangling SKILL.md symlink in a renamed child dir (SEC-FINAL-03)', () => {
        setup();
        // Child dir name differs from the requested runtime name; a DANGLING
        // SKILL.md symlink is still a present violation — never a skip that
        // falls through to the global fallback.
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        symlinkSync(path.join(external, 'missing-target.md'), path.join(slotDir, 'SKILL.md'), 'file');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/SKILL\.md is not a regular file/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('propagates lstat permission errors on child SKILL candidates (SEC-FINAL-03)', () => {
        setup();
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        writeFileSync(path.join(slotDir, 'SKILL.md'), '# skill');
        chmodSync(slotDir, 0);
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            let msg = '';
            try { resolveRequestedSkills(fakeRepo, ['service-knowledge']); } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            }
            expect(msg).toMatch(/cannot probe|EACCES/);
            expect(msg).not.toContain(sandbox);
        } finally {
            chmodSync(slotDir, 0o755);
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('fails loudly on a top-level non-reserved symlink pack (never global fallback)', () => {
        setup();
        const externalPack = path.join(external, 'pack');
        mkdirSync(path.join(externalPack, 'service-knowledge'), { recursive: true });
        writeFileSync(path.join(externalPack, 'service-knowledge', 'SKILL.md'), '# external');
        mkdirSync(path.join(fakeRepo, '.xtrm', 'skills'), { recursive: true });
        symlinkSync(externalPack, path.join(fakeRepo, '.xtrm', 'skills', 'infra'), 'dir');
        withHomeEnv(() => {
            expect(() => resolveRequestedSkills(fakeRepo, ['service-knowledge']))
                .toThrow(/is a symlink/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('sanitizes and bounds hostile skill-request diagnostics for every runtime', () => {
        setup();
        const controls = 'bad\n\u001b]52;c;payload\u0007\u009b';
        const requests = [
            `.xtrm/skills/infra/${controls}${'x'.repeat(512)}`,
            path.join(external, `${controls}${'y'.repeat(512)}`),
        ];
        withHomeEnv(() => {
            for (const runtime of ['pi', 'claude', 'codex'] as const) {
                for (const request of requests) {
                    let message = '';
                    try { resolveRequestedSkills(fakeRepo, [request], runtime); } catch (error) {
                        message = error instanceof Error ? error.message : String(error);
                    }
                    expect(message).toContain('\\u{0a}');
                    expect(message).toContain('\\u{1b}');
                    expect(message).toContain('\\u{07}');
                    expect(message).toContain('\\u{9b}');
                    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
                    expect(message).not.toContain(sandbox);
                    expect(message.length).toBeLessThan(400);
                }
            }
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('treats an explicit pack-root DIRECTORY as pack-shaped for pi and codex (751b HIGH)', () => {
        setup();
        // Missing root SKILL.md -> malformed/missing must fail before launch.
        const packDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra');
        mkdirSync(packDir, { recursive: true });
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            for (const runtime of ['pi', 'codex'] as const) {
                expect(() => resolveRequestedSkills(fakeRepo, [packDir], runtime))
                    .toThrow(/has no SKILL\.md/);
            }
            // Valid root skill (frontmatter runtime name) resolves for both.
            writeFileSync(path.join(packDir, 'SKILL.md'), '---\nname: service-knowledge\n---\n# root');
            expect(resolveRequestedSkills(fakeRepo, [packDir], 'pi')).toEqual([path.join(packDir, 'SKILL.md')]);
            expect(resolveRequestedSkills(fakeRepo, [packDir], 'codex')).toEqual([path.join(packDir, 'SKILL.md')]);
            // Malformed root SKILL.md (unsafe identity) fails for both.
            rmSync(path.join(packDir, 'SKILL.md'));
            writeFileSync(path.join(packDir, 'SKILL.md'), '---\nname: ../evil\n---\n# bad');
            expect(() => resolveRequestedSkills(fakeRepo, [packDir], 'pi')).toThrow(/unsafe runtime name/);
            expect(() => resolveRequestedSkills(fakeRepo, [packDir], 'codex')).toThrow(/unsafe runtime name/);
            // Full pi/codex matrix across child dir/file + root file forms.
            const childDir = path.join(packDir, 'catalog');
            for (const runtime of ['pi', 'codex'] as const) {
                // absent slot -> fail, no home fallback
                expect(() => resolveRequestedSkills(fakeRepo, [childDir], runtime)).toThrow();
                expect(() => resolveRequestedSkills(fakeRepo, [path.join(childDir, 'SKILL.md')], runtime)).toThrow();
                expect(() => resolveRequestedSkills(fakeRepo, [path.join(packDir, 'SKILL.md')], runtime)).toThrow();
            }
            const repoSlotFile = path.join(childDir, 'SKILL.md');
            mkdirSync(childDir, { recursive: true });
            writeFileSync(repoSlotFile, '---\nname: catalog-skill\n---\n# repo');
            rmSync(path.join(packDir, 'SKILL.md'));
            for (const runtime of ['pi', 'codex'] as const) {
                expect(resolveRequestedSkills(fakeRepo, [childDir], runtime)).toEqual([repoSlotFile]);
                expect(resolveRequestedSkills(fakeRepo, [path.join(childDir, 'SKILL.md')], runtime)).toEqual([repoSlotFile]);
            }
            writeFileSync(path.join(packDir, 'SKILL.md'), '---\nname: service-knowledge\n---\n# root');
            expect(resolveRequestedSkills(fakeRepo, [packDir], 'pi')).toEqual([path.join(packDir, 'SKILL.md')]);
            expect(resolveRequestedSkills(fakeRepo, [packDir], 'codex')).toEqual([path.join(packDir, 'SKILL.md')]);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('pins RELATIVE pack-shaped requests to the repo root; HOME content never selected (c7e)', () => {
        setup();
        // Repo lacks the pack skill, HOME has matching content under .xtrm:
        // the relative request must fail prelaunch, never home-fallback.
        const homeSlot = path.join(fakeHome, '.xtrm', 'skills', 'infra', 'catalog', 'SKILL.md');
        mkdirSync(path.dirname(homeSlot), { recursive: true });
        writeFileSync(homeSlot, '# home content');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            for (const runtime of ['pi', 'claude', 'codex'] as const) {
                // child dir + child file forms.
                expect(() => resolveRequestedSkills(fakeRepo, ['.xtrm/skills/infra/catalog'], runtime))
                    .toThrow(/not a valid project-pack skill/);
                expect(() => resolveRequestedSkills(fakeRepo, ['.xtrm/skills/infra/catalog/SKILL.md'], runtime))
                    .toThrow(/not a valid project-pack skill/);
            }
            // Pack-root DIRECTORY and root-file forms: repo missing, home has
            // root skill -> still pinned to repo, fails.
            const homeRoot = path.join(fakeHome, '.xtrm', 'skills', 'infra', 'SKILL.md');
            mkdirSync(path.dirname(homeRoot), { recursive: true });
            writeFileSync(homeRoot, '# home root');
            expect(() => resolveRequestedSkills(fakeRepo, ['.xtrm/skills/infra'], 'pi'))
                .toThrow(/not a valid project-pack skill/);
            expect(() => resolveRequestedSkills(fakeRepo, ['.xtrm/skills/infra/SKILL.md'], 'claude'))
                .toThrow(/not a valid project-pack skill/);
            // When the repo pack exists and is valid it resolves to the REPO
            // skill (never home), even with matching HOME content.
            const repoSlot = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog', 'SKILL.md');
            mkdirSync(path.dirname(repoSlot), { recursive: true });
            writeFileSync(repoSlot, '---\nname: catalog-skill\n---\n# repo');
            expect(resolveRequestedSkills(fakeRepo, ['.xtrm/skills/infra/catalog'], 'pi')).toEqual([repoSlot]);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('parses frontmatter runtime names beyond 8KiB (751b)', () => {
        setup();
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(skillDir, { recursive: true });
        const pad = '# ' + 'x'.repeat(9 * 1024);
        const skillFile = path.join(skillDir, 'SKILL.md');
        writeFileSync(skillFile, `---\n${pad}\nname: service-knowledge\n---\n# long`);
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            const resolved = resolveRequestedSkills(fakeRepo, ['service-knowledge'], 'claude');
            expect(resolved).toEqual([skillFile]);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('normalizes explicit pack DIRECT paths through the strict probe for every runtime (SEC-196-03)', () => {
        setup();
        // Unsafe frontmatter identity on a DIRECT absolute pack path.
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: ../evil\n---\n# bad');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            for (const runtime of ['pi', 'claude', 'codex'] as const) {
                // Directory form and SKILL.md form both fail pre-launch.
                expect(() => resolveRequestedSkills(fakeRepo, [slotFile], runtime))
                    .toThrow(/unsafe runtime name/);
                expect(() => resolveRequestedSkills(fakeRepo, [slotDir], runtime))
                    .toThrow(/unsafe runtime name/);
            }
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects malformed explicit pack DIRECT paths for pi before launch (SEC-196-03)', () => {
        const cases: Array<{ setup: () => string; match: RegExp }> = [
            {
                // dangling SKILL.md symlink: pack-shaped direct route -> the
                // strict probe reports the malformed link, never a generic
                // fallback and never a forwarded pi path
                setup: () => {
                    const dir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
                    mkdirSync(dir, { recursive: true });
                    symlinkSync(path.join(external, 'gone.md'), path.join(dir, 'SKILL.md'), 'file');
                    return path.join(dir, 'SKILL.md');
                },
                match: /not a regular file/,
            },
            {
                // SKILL.md is a directory: pack-shaped -> strict probe rejects
                setup: () => {
                    const dir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
                    mkdirSync(path.join(dir, 'SKILL.md'), { recursive: true });
                    return path.join(dir, 'SKILL.md');
                },
                match: /not a regular file/,
            },
            {
                // control-byte frontmatter name with escaped diagnostic
                setup: () => {
                    const dir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: bad\u0007name\n---\n# x');
                    return path.join(dir, 'SKILL.md');
                },
                match: /unsafe runtime name/,
            },
        ];
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            for (const c of cases) {
                rmSync(sandbox, { recursive: true, force: true });
                mkdirSync(fakeRepo, { recursive: true });
                mkdirSync(fakeHome, { recursive: true });
                const target = c.setup();
                expect(() => resolveRequestedSkills(fakeRepo, [target], 'pi')).toThrow(c.match);
            }
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});

describe('claude pack-skill loadability', () => {
    const sandbox = path.join(os.tmpdir(), `xtrm-claude-pack-links-${process.pid}`);
    const fakeHome = path.join(sandbox, 'home');
    const fakeRepo = path.join(sandbox, 'repo');
    const fakeWorktree = path.join(sandbox, 'worktree');

    function setupPack(packName: string, skillName: string): string {
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', packName, skillName);
        mkdirSync(skillDir, { recursive: true });
        const skillFile = path.join(skillDir, 'SKILL.md');
        writeFileSync(skillFile, `# ${packName}/${skillName}`);
        return skillFile;
    }

    // SEC-05: launcher links the WORKTREE-LOCAL tracked copy of the pack. A
    // real worktree receives the pack via git checkout, so fixtures mirror the
    // pack skill into the fake worktree.
    function mirrorPackToWorktree(packName: string, skillName: string): string {
        const wtSkillFile = path.join(fakeWorktree, '.xtrm', 'skills', packName, skillName, 'SKILL.md');
        mkdirSync(path.dirname(wtSkillFile), { recursive: true });
        writeFileSync(wtSkillFile, `# ${packName}/${skillName}`);
        return wtSkillFile;
    }

    function withHomeEnv(fn: () => void): void {
        const prev = process.env.HOME;
        process.env.HOME = fakeHome;
        try { fn(); } finally { process.env.HOME = prev; }
    }

    it('links pack-tier skills into the worktree .claude/skills as /<name>', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const skillFile = setupPack('infra', 'service-knowledge');
        const wtSkillFile = mirrorPackToWorktree('infra', 'service-knowledge');
        withHomeEnv(() => {
            // The resolver returns MAIN-ROOT pack paths; materialization maps
            // them onto the worktree-local tracked copies.
            const created = ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [skillFile]);
            const link = path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge');
            expect(created).toEqual([link]);
            // Targets resolve relative to the link's own directory (.claude/skills)
            // and point at the WORKTREE-LOCAL pack copy.
            expect(readlinkSync(link)).toBe(path.relative(path.dirname(link), path.dirname(wtSkillFile)));
            expect(realpathSync(path.join(link, 'SKILL.md'))).toBe(wtSkillFile);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('fails when the worktree-local pack copy is absent (pack must be tracked)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const skillFile = setupPack('infra', 'service-knowledge');
        withHomeEnv(() => {
            expect(() => ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [skillFile]))
                .toThrow(/must be tracked/);
            expect(existsSync(path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge'))).toBe(false);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('never overwrites an occupied worktree slot', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        setupPack('infra', 'service-knowledge');
        mirrorPackToWorktree('infra', 'service-knowledge');
        const occupant = path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(occupant), { recursive: true });
        writeFileSync(occupant, '# repo-owned');
        withHomeEnv(() => {
            expect(() => ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [
                path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge'),
            ]))
                .toThrow(/already holds a different skill/);
            expect(readFileSync(occupant, 'utf8')).toBe('# repo-owned');
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('accepts an occupied worktree slot that already resolves to the requested skill', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        setupPack('infra', 'service-knowledge');
        const wtSkillDir = path.join(fakeWorktree, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(wtSkillDir, { recursive: true });
        writeFileSync(path.join(wtSkillDir, 'SKILL.md'), '# skill');
        const existingLink = path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge');
        mkdirSync(path.dirname(existingLink), { recursive: true });
        symlinkSync(wtSkillDir, existingLink, 'dir');
        withHomeEnv(() => {
            const resolvedDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
            expect(ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [resolvedDir])).toEqual([]);
            expect(existsSync(existingLink)).toBe(true);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('fails hard on a same-named user-global slot instead of shadowing', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const skillFile = setupPack('infra', 'service-knowledge');
        const globalSlot = path.join(fakeHome, '.claude', 'skills', 'service-knowledge');
        mkdirSync(globalSlot, { recursive: true });
        writeFileSync(path.join(globalSlot, 'SKILL.md'), '# global');
        withHomeEnv(() => {
            expect(() => ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [skillFile]))
                .toThrow(/same-named user-global/);
            expect(existsSync(path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge'))).toBe(false);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('links directory-form pack paths to the worktree skill dir, not the pack root', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill');
        const wtSkillDir = path.join(fakeWorktree, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(wtSkillDir, { recursive: true });
        writeFileSync(path.join(wtSkillDir, 'SKILL.md'), '# skill');
        withHomeEnv(() => {
            const created = ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [skillDir]);
            const link = path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge');
            expect(created).toEqual([link]);
            expect(realpathSync(link)).toBe(wtSkillDir);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects a deeper descendant of a pack skill as non-pack and requires native discovery', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const descendant = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge', 'nested', 'SKILL.md');
        mkdirSync(path.dirname(descendant), { recursive: true });
        writeFileSync(descendant, '# nested');
        withHomeEnv(() => {
            // Pack helpers ignore it: it is not a pack skill and no link is
            // materialized.
            expect(ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [descendant])).toEqual([]);
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [descendant])).not.toThrow();
            // Acceptance evidence is the production gate: claude must discover
            // the exact canonical skill natively or the launch fails. Nothing
            // is discoverable under the fake root, so the native gate rejects
            // the dead slash before launch.
            expect(() => assertClaudeSkillsDiscoverable(fakeRepo, [descendant]))
                .toThrow(/not discoverable by Claude/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('leaves non-pack paths untouched', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const native = path.join(fakeRepo, '.pi', 'skills', 'multiplexing', 'SKILL.md');
        mkdirSync(path.dirname(native), { recursive: true });
        writeFileSync(native, '# native');
        withHomeEnv(() => {
            expect(ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [native])).toEqual([]);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects an explicit/role pack skill shadowed by a same-named global default', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const skillFile = setupPack('infra', 'service-knowledge');
        const globalSlot = path.join(fakeHome, '.claude', 'skills', 'service-knowledge');
        mkdirSync(globalSlot, { recursive: true });
        writeFileSync(path.join(globalSlot, 'SKILL.md'), '# global');
        withHomeEnv(() => {
            // The gate takes the combined role-declared + explicit set; a
            // role-declared pack path alone must be rejected the same way.
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [skillFile]))
                .toThrow(/same-named global/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects an explicit pack skill whose main-root slot holds different content', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const skillFile = setupPack('infra', 'service-knowledge');
        const other = path.join(fakeRepo, '.claude', 'skills', 'service-knowledge', 'SKILL.md');
        mkdirSync(path.dirname(other), { recursive: true });
        writeFileSync(other, '# different');
        withHomeEnv(() => {
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [skillFile]))
                .toThrow(/already holds a different skill/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects two different project packs behind one slash name before creation (SEC-06)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const fromA = setupPack('infra', 'service-knowledge');
        const fromB = setupPack('market-data', 'service-knowledge');
        withHomeEnv(() => {
            let msg = '';
            try { assertClaudePackSkillsLoadable(fakeRepo, [fromA, fromB]); } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            }
            expect(msg).toMatch(/declared from two different project packs/);
            expect(msg).toContain('.xtrm/skills/infra/service-knowledge');
            expect(msg).toContain('.xtrm/skills/market-data/service-knowledge');
            expect(msg).not.toContain(sandbox);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('uses the canonical runtimeName for shadow and conflict identity (SEC-NEW-02)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        // Directory 'catalog' but canonical runtime identity 'service-knowledge'.
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: service-knowledge\n---\n# renamed');
        const globalSlot = path.join(fakeHome, '.claude', 'skills', 'service-knowledge');
        mkdirSync(globalSlot, { recursive: true });
        writeFileSync(path.join(globalSlot, 'SKILL.md'), '# global');
        withHomeEnv(() => {
            // The shadow check must key on the runtimeName, not the 'catalog'
            // directory basename.
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [slotFile]))
                .toThrow(/'\/service-knowledge'.*same-named global/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('links claude skills by canonical runtimeName, not directory name (SEC-NEW-02)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: service-knowledge\n---\n# renamed');
        const wtSlotDir = path.join(fakeWorktree, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(wtSlotDir, { recursive: true });
        writeFileSync(path.join(wtSlotDir, 'SKILL.md'), '---\nname: service-knowledge\n---\n# renamed');
        withHomeEnv(() => {
            const created = ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [slotFile]);
            // The link is '/service-knowledge', never '/catalog'.
            const link = path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge');
            expect(created).toEqual([link]);
            expect(existsSync(path.join(fakeWorktree, '.claude', 'skills', 'catalog'))).toBe(false);
            expect(realpathSync(path.join(link, 'SKILL.md'))).toBe(path.join(wtSlotDir, 'SKILL.md'));
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects a divergent worktree copy whose runtimeName differs (SEC-NEW-02)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: service-knowledge\n---\n# renamed');
        const wtSlotDir = path.join(fakeWorktree, '.xtrm', 'skills', 'infra', 'catalog');
        mkdirSync(wtSlotDir, { recursive: true });
        // Worktree copy has a DIFFERENT runtime identity.
        writeFileSync(path.join(wtSlotDir, 'SKILL.md'), '---\nname: other-skill\n---\n# divergent');
        withHomeEnv(() => {
            expect(() => ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, [slotFile]))
                .toThrow(/declares runtime name 'other-skill'/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects an unsafe runtimeName at the claude preflight gate', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: ../evil\n---\n# bad');
        withHomeEnv(() => {
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [slotFile]))
                .toThrow(/unsafe runtime name/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects divergent canonical runtimeName shadow when bound alias differs (reviewer 7f5)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        withHomeEnv(() => {
            // Bound alias 'service-knowledge'; canonical runtime name slot in
            // the main root holds DIFFERENT content -> reject. The alias entry
            // (bound via the deterministic policy) drives the divergent check.
            const [entry] = bindClaudePackNames(fakeRepo, [slotFile], ['service-knowledge'], [], 'claude').roleEntries;
            const canonicalSlot = path.join(fakeRepo, '.claude', 'skills', 'infra-xt-claude-sk-reconcile-infra-service-knowledge', 'SKILL.md');
            mkdirSync(path.dirname(canonicalSlot), { recursive: true });
            writeFileSync(canonicalSlot, '# different');
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [entry]))
                .toThrow(/canonical runtime name .* occupied by a different skill/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('allows same canonical content in the divergent runtimeName slot (reviewer 7f5)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        writeFileSync(path.join(slotDir, 'SKILL.md'), '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        const canonicalSlot = path.join(fakeRepo, '.claude', 'skills', 'infra-xt-claude-sk-reconcile-infra-service-knowledge');
        mkdirSync(path.dirname(canonicalSlot), { recursive: true });
        symlinkSync(slotDir, canonicalSlot, 'dir');
        withHomeEnv(() => {
            const [entry] = bindClaudePackNames(fakeRepo, [path.join(slotDir, 'SKILL.md')], ['service-knowledge'], [], 'claude').roleEntries;
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [entry])).not.toThrow();
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects a divergent canonical runtimeName user-global shadow (reviewer 7f5)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        const globalSlot = path.join(fakeHome, '.claude', 'skills', 'infra-xt-claude-sk-reconcile-infra-service-knowledge');
        mkdirSync(globalSlot, { recursive: true });
        writeFileSync(path.join(globalSlot, 'SKILL.md'), '# global');
        withHomeEnv(() => {
            const [entry] = bindClaudePackNames(fakeRepo, [slotFile], ['service-knowledge'], [], 'claude').roleEntries;
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [entry]))
                .toThrow(/shadowed by a global skill/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('pairs prefix names by declaration index across mixed pack+global declarations (probe available)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        // Canonical service-knowledge-sync shape: pack service-knowledge at
        // index 0, two GLOBAL skills at indices 1-2.
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        const globals = [
            path.join(fakeHome, '.xtrm', 'skills', 'default', 'gitnexus-impact-analysis', 'SKILL.md'),
            path.join(fakeHome, '.xtrm', 'skills', 'default', 'gitnexus-exploring', 'SKILL.md'),
        ];
        for (const g of globals) mkdirSync(path.dirname(g), { recursive: true });
        writeFileSync(globals[0], '# gn1');
        writeFileSync(globals[1], '# gn2');
        const wtSlotDir = path.join(fakeWorktree, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(wtSlotDir, { recursive: true });
        writeFileSync(path.join(wtSlotDir, 'SKILL.md'), '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        withHomeEnv(() => {
            // sp renders the prefix across ALL three declarations, in order;
            // binding maps each prefix name to its declaration identity.
            const prefixNames = ['service-knowledge', 'gitnexus-impact-analysis', 'gitnexus-exploring'];
            const { roleEntries, explicitEntries } = bindClaudePackNames(
                fakeRepo,
                [slotFile, globals[0], globals[1]],
                prefixNames,
                [],
                'claude',
            );
            expect(explicitEntries).toHaveLength(0);
            expect(roleEntries).toHaveLength(1);
            expect(roleEntries[0].name).toBe('service-knowledge');
            // Materialize and verify the alias link.
            const created = ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, roleEntries);
            expect(created).toEqual([path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge')]);
            expect(realpathSync(path.join(created[0], 'SKILL.md'))).toBe(path.join(wtSlotDir, 'SKILL.md'));
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('binds runtimeName when the sp renderer is unavailable (probe unavailable)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        try {
            // No prefix names (fallback): entry binds runtimeName, which is
            // exactly what renderDeclaredSkillPrefix with the entries emits
            // (agreement between prefix and link).
            const { roleEntries } = bindClaudePackNames(fakeRepo, [slotFile], null, [], 'claude');
            expect(roleEntries).toHaveLength(1);
            expect(roleEntries[0].name).toBe('infra-xt-claude-sk-reconcile-infra-service-knowledge');
            expect(renderDeclaredSkillPrefix([slotFile], 'claude', fakeRepo, roleEntries))
                .toBe('/infra-xt-claude-sk-reconcile-infra-service-knowledge\n\n');
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('coalesces role + explicit identities into one bound name, order independent (SEC-fa12)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        const wtSlotDir = path.join(fakeWorktree, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(wtSlotDir, { recursive: true });
        writeFileSync(path.join(wtSlotDir, 'SKILL.md'), '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        withHomeEnv(() => {
            // Role declaration (sp-resolved slot path) + explicit --skill of
            // the SAME slot; both request orders must bind the same name.
            const a = bindClaudePackNames(fakeRepo, [slotFile], ['service-knowledge'], [slotFile], 'claude');
            const b = bindClaudePackNames(fakeRepo, [slotFile], ['service-knowledge'], ['service-knowledge'], 'claude');
            for (const result of [a, b]) {
                const merged = [...result.roleEntries, ...result.explicitEntries]
                    .filter((e, i, all) => all.findIndex((x) => x.canonicalPath === e.canonicalPath) === i);
                expect(merged).toHaveLength(1);
                expect(merged[0].name).toBe('service-knowledge');
            }
            // Explicit command for the identity is dropped from turn-1 because
            // the role prefix already carries '/service-knowledge'.
            const mergedFor = (r: { roleEntries: Array<{ canonicalPath: string; name: string }>; explicitEntries: Array<{ canonicalPath: string; name: string }> }): ClaudePackSkillEntry[] =>
                [...r.roleEntries, ...r.explicitEntries] as ClaudePackSkillEntry[];
            const lines = composeClaudeExplicitLines(fakeRepo, [slotFile], mergedFor(a), new Set(['service-knowledge']));
            expect(lines).toBe('');
            // Materialize one alias link.
            const created = ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, mergedFor(a));
            expect(created).toEqual([path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge')]);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('composes the fallback role block + explicit alias to one command (ca9/751b)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        mkdirSync(fakeWorktree, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        const wtSlotDir = path.join(fakeWorktree, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(wtSlotDir, { recursive: true });
        writeFileSync(path.join(wtSlotDir, 'SKILL.md'), '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        withHomeEnv(() => {
            // Fallback (no sp prefix names): role declares the slot PATH,
            // explicit --skill names the ALIAS for the same identity.
            const { roleEntries, explicitEntries } = bindClaudePackNames(fakeRepo, [slotFile], null, ['service-knowledge'], 'claude');
            expect(roleEntries).toHaveLength(1);
            expect(roleEntries[0].name).toBe('service-knowledge');
            expect(explicitEntries).toHaveLength(0);
            // Role block carries the single command; explicit adds nothing.
            const block = composeClaudeRoleBlock(fakeRepo, [slotFile], null, roleEntries, 'claude');
            expect(block).toBe('/service-knowledge\n\n');
            const explicitLines = composeClaudeExplicitLines(fakeRepo, [slotFile], [...roleEntries, ...explicitEntries], new Set(['service-knowledge']));
            expect(explicitLines).toBe('');
            // One alias link materialized.
            const created = ensureClaudePackSkillLinks(fakeWorktree, fakeRepo, roleEntries);
            expect(created).toEqual([path.join(fakeWorktree, '.claude', 'skills', 'service-knowledge')]);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects role declarations that name a skill outside its slot/runtime names (reviewer 78)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        try {
            // 'other-alias' is neither the slot name nor the canonical runtime
            // name: must reject before creation, not bind.
            expect(() => bindClaudePackNames(fakeRepo, [slotFile, slotFile], ['service-knowledge', 'other-alias'], [], 'claude'))
                .toThrow(/neither its slot name/);
            // Canonical runtimeName as the second name is allowed; slot wins.
            const { roleEntries } = bindClaudePackNames(
                fakeRepo,
                [slotFile, slotFile],
                ['service-knowledge', 'infra-xt-claude-sk-reconcile-infra-service-knowledge'],
                [],
                'claude',
            );
            expect(roleEntries).toHaveLength(1);
            expect(roleEntries[0].name).toBe('service-knowledge');
            // Per-declaration reconstruction: exactly one command.
            const block = composeClaudeRoleBlock(fakeRepo, [slotFile, slotFile], ['service-knowledge', 'infra-xt-claude-sk-reconcile-infra-service-knowledge'], roleEntries, 'claude');
            expect(block).toBe('/service-knowledge\n\n');
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('binds explicit permutations deterministically to the slot alias (SEC-03)', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const slotDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(slotDir, { recursive: true });
        const slotFile = path.join(slotDir, 'SKILL.md');
        writeFileSync(slotFile, '---\nname: infra-xt-claude-sk-reconcile-infra-service-knowledge\n---\n# real');
        try {
            // Every ordering of {abs path, SKILL.md path, bare slot alias,
            // canonical runtime name} binds the slot alias.
            const orders = [
                [slotFile, 'service-knowledge'],
                ['service-knowledge', slotFile],
                [path.join(slotDir, 'SKILL.md'), 'service-knowledge'],
                ['service-knowledge', 'infra-xt-claude-sk-reconcile-infra-service-knowledge', slotFile],
            ];
            for (const req of orders) {
                const { explicitEntries } = bindClaudePackNames(fakeRepo, [], null, req, 'claude');
                expect(explicitEntries).toHaveLength(1);
                expect(explicitEntries[0].name).toBe('service-knowledge');
            }
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('accepts the same project pack path declared twice', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const skillFile = setupPack('infra', 'service-knowledge');
        withHomeEnv(() => {
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [skillFile, skillFile])).not.toThrow();
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('rejects a same-named global even when the local slot already holds the requested skill', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const skillDir = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'service-knowledge');
        mkdirSync(skillDir, { recursive: true });
        const skillFile = path.join(skillDir, 'SKILL.md');
        writeFileSync(skillFile, '# skill');
        // Local slot already resolves to the requested pack skill...
        const localSlot = path.join(fakeRepo, '.claude', 'skills', 'service-knowledge');
        mkdirSync(path.dirname(localSlot), { recursive: true });
        symlinkSync(skillDir, localSlot, 'dir');
        // ...but a different same-named global exists: the pack skill would
        // still be shadowed for claude (user-global wins), so it must fail.
        const globalSlot = path.join(fakeHome, '.claude', 'skills', 'service-knowledge');
        mkdirSync(globalSlot, { recursive: true });
        writeFileSync(path.join(globalSlot, 'SKILL.md'), '# global');
        withHomeEnv(() => {
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [skillFile]))
                .toThrow(/same-named global/);
        });
        rmSync(sandbox, { recursive: true, force: true });
    });

    it('accepts an explicit pack skill with free runtime slots', () => {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeRepo, { recursive: true });
        const skillFile = setupPack('infra', 'service-knowledge');
        withHomeEnv(() => {
            expect(() => assertClaudePackSkillsLoadable(fakeRepo, [skillFile])).not.toThrow();
        });
        rmSync(sandbox, { recursive: true, force: true });
    });
});

describe('assertClaudeSkillsDiscoverable', () => {
    const sandbox = path.join(os.tmpdir(), `claude-skill-discovery-${process.pid}`);
    const fakeHome = path.join(sandbox, 'home');
    const fakeRepo = path.join(sandbox, 'repo');

    it('accepts a requested skill only when Claude discovers the same canonical path', () => {
        const skill = path.join(fakeHome, '.xtrm', 'skills', 'default', 'foo');
        const pointer = path.join(fakeHome, '.claude', 'skills', 'foo');
        mkdirSync(skill, { recursive: true });
        mkdirSync(path.dirname(pointer), { recursive: true });
        writeFileSync(path.join(skill, 'SKILL.md'), '# foo');
        symlinkSync(skill, pointer, 'dir');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => assertClaudeSkillsDiscoverable(fakeRepo, [path.join(skill, 'SKILL.md')]))
                .not.toThrow();
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects a discoverable path whose name could inject another slash command', () => {
        const skill = path.join(fakeHome, '.xtrm', 'skills', 'default', 'safe\nevil');
        const pointer = path.join(fakeHome, '.claude', 'skills', 'safe\nevil');
        mkdirSync(skill, { recursive: true });
        mkdirSync(path.dirname(pointer), { recursive: true });
        writeFileSync(path.join(skill, 'SKILL.md'), '# unsafe name');
        symlinkSync(skill, pointer, 'dir');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => assertClaudeSkillsDiscoverable(fakeRepo, [path.join(skill, 'SKILL.md')]))
                .toThrow(/invalid Claude skill name/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects a same-name skill whose canonical path differs', () => {
        const requested = path.join(sandbox, 'external', 'foo');
        const discovered = path.join(fakeHome, '.claude', 'skills', 'foo');
        mkdirSync(requested, { recursive: true });
        mkdirSync(discovered, { recursive: true });
        writeFileSync(path.join(requested, 'SKILL.md'), '# requested');
        writeFileSync(path.join(discovered, 'SKILL.md'), '# discovered');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => assertClaudeSkillsDiscoverable(fakeRepo, [path.join(requested, 'SKILL.md')]))
                .toThrow(/not discoverable by Claude as '\/foo'/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('rejects an arbitrary path that Claude cannot discover', () => {
        const skill = path.join(sandbox, 'external', 'foo');
        mkdirSync(skill, { recursive: true });
        writeFileSync(path.join(skill, 'SKILL.md'), '# foo');
        const previousHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            expect(() => assertClaudeSkillsDiscoverable(fakeRepo, [path.join(skill, 'SKILL.md')]))
                .toThrow(/not discoverable by Claude as '\/foo'/);
        } finally {
            process.env.HOME = previousHome;
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});

describe('buildBufferedRuntimeCommand', () => {
    it('keeps untrusted runtime content out of the command and cleans up on consume or signal', () => {
        const command = buildBufferedRuntimeCommand('xtrm-role-safe');
        expect(command).toContain('consumer-ready');
        expect(command).toContain('timeout: 5000');
        expect(command).toContain('show-buffer');
        expect(command).toContain('delete-buffer');
        expect(command).toContain('SIGINT');
        expect(command).toContain('SIGTERM');
        expect(command).toContain('SIGHUP');
        expect(command).toContain('node:path');
        expect(command).toContain('path.basename(payload.runtimeCmd)');
        expect(command).toContain('xtrm-role-safe');
        expect(command).not.toContain('rendered bead body');
    });

    it.each([false, true])('times out and deletes the buffer when the parent disappears (loaded=%s)', (loaded) => {
        const sandbox = path.join(os.tmpdir(), `xtrm-wrapper-timeout-${process.pid}-${loaded}`);
        const bin = path.join(sandbox, 'bin');
        const log = path.join(sandbox, 'tmux.log');
        const bufferFile = path.join(sandbox, 'buffer');
        const buffer = 'xtrm-role-timeout-test';
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(bin, { recursive: true });
        writeFileSync(path.join(bin, 'tmux'), `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.XTRM_TMUX_LOG, [command, ...args].join(' ') + '\\n');
if (command === 'wait-for' && args[0] === '-S') process.exit(0);
if (command === 'wait-for') {
  setInterval(() => {}, 1000);
} else if (command === 'delete-buffer') {
  fs.rmSync(process.env.XTRM_BUFFER_FILE, { force: true });
  process.exit(0);
} else {
  process.exit(2);
}
`);
        chmodSync(path.join(bin, 'tmux'), 0o755);
        if (loaded) writeFileSync(bufferFile, 'payload');

        const started = Date.now();
        const result = spawnSync('sh', ['-c', buildBufferedRuntimeCommand(buffer, 250)], {
            encoding: 'utf8',
            timeout: 2_000,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ''}`,
                XTRM_TMUX_LOG: log,
                XTRM_BUFFER_FILE: bufferFile,
            },
        });

        expect(result.status).not.toBe(0);
        expect(Date.now() - started).toBeLessThan(1_500);
        expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
            `wait-for -S ${buffer}-consumer-ready`,
            `wait-for ${buffer}-ready`,
            `delete-buffer -b ${buffer}`,
        ]);
        expect(existsSync(bufferFile)).toBe(false);
        rmSync(sandbox, { recursive: true, force: true });
    });
});

describe('createRuntimeBufferName', () => {
    it('uses a collision-resistant 128-bit random suffix', () => {
        const names = new Set(Array.from({ length: 100 }, createRuntimeBufferName));
        expect(names.size).toBe(100);
        for (const name of names) expect(name).toMatch(/^xtrm-role-[0-9a-f]{32}$/);
    });
});

describe('claudeExplicitSkillLines', () => {
    it('derives skill name from SKILL.md path via parent dir', () => {
        expect(claudeExplicitSkillLines(['/home/u/.claude/skills/foo/SKILL.md']))
            .toBe('/foo');
    });

    it('derives skill name from directory path via basename', () => {
        expect(claudeExplicitSkillLines(['/home/u/.claude/skills/bar']))
            .toBe('/bar');
    });

    it('joins multiple skills with newlines in input order', () => {
        expect(claudeExplicitSkillLines([
            '/home/u/.claude/skills/a/SKILL.md',
            '/home/u/.claude/skills/b',
            '/home/u/.claude/skills/c/SKILL.md',
        ])).toBe('/a\n/b\n/c');
    });

    it('returns empty string when no paths given', () => {
        expect(claudeExplicitSkillLines([])).toBe('');
    });

    it('renders the canonical runtimeName for renamed pack skills (SEC-NEW-02)', () => {
        const sandbox = path.join(os.tmpdir(), `xtrm-explicit-lines-${process.pid}`);
        const fakeRepo = path.join(sandbox, 'repo');
        mkdirSync(path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog'), { recursive: true });
        const slotFile = path.join(fakeRepo, '.xtrm', 'skills', 'infra', 'catalog', 'SKILL.md');
        writeFileSync(slotFile, '---\nname: service-knowledge\n---\n# renamed');
        try {
            expect(claudeExplicitSkillLines([slotFile], fakeRepo)).toBe('/service-knowledge');
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});

describe('resolveSkillPath', () => {
    const sandbox = path.join(os.tmpdir(), `xtmux-1rn-test-${process.pid}`);
    const fakeHome = path.join(sandbox, 'home');
    const fakeRepo = path.join(sandbox, 'repo');
    const rel = '.xtrm/skills/active/multiplexing/SKILL.md';

    function setup(): void {
        rmSync(sandbox, { recursive: true, force: true });
        mkdirSync(fakeHome, { recursive: true });
        mkdirSync(fakeRepo, { recursive: true });
    }

    function teardown(): void {
        rmSync(sandbox, { recursive: true, force: true });
    }

    function withHomeEnv(fn: () => void): void {
        const prev = process.env.HOME;
        process.env.HOME = fakeHome;
        try { fn(); } finally { process.env.HOME = prev; }
    }

    it('returns repo-resolved path when file exists in mainRepoRoot', () => {
        setup();
        const repoFile = path.join(fakeRepo, rel);
        mkdirSync(path.dirname(repoFile), { recursive: true });
        writeFileSync(repoFile, '# skill');
        withHomeEnv(() => {
            expect(resolveSkillPath(fakeRepo, rel)).toBe(repoFile);
        });
        teardown();
    });

    it('falls back to $HOME when repo path is missing but home has it', () => {
        setup();
        const homeFile = path.join(fakeHome, rel);
        mkdirSync(path.dirname(homeFile), { recursive: true });
        writeFileSync(homeFile, '# global skill');
        withHomeEnv(() => {
            expect(resolveSkillPath(fakeRepo, rel)).toBe(homeFile);
        });
        teardown();
    });

    it('maps retired active paths to the migrated global default tree', () => {
        setup();
        const migrated = path.join(fakeHome, '.xtrm', 'skills', 'default', 'multiplexing', 'SKILL.md');
        mkdirSync(path.dirname(migrated), { recursive: true });
        writeFileSync(migrated, '# migrated global skill');
        withHomeEnv(() => {
            expect(resolveSkillPath(fakeRepo, rel)).toBe(migrated);
        });
        teardown();
    });

    it('returns repo-resolved path when both miss (pi produces the loud error)', () => {
        setup();
        withHomeEnv(() => {
            expect(resolveSkillPath(fakeRepo, rel)).toBe(path.resolve(fakeRepo, rel));
        });
        teardown();
    });

    it('honors absolute paths verbatim (no fallback)', () => {
        expect(resolveSkillPath(fakeRepo, '/etc/hosts')).toBe('/etc/hosts');
    });

    it('expands ~ and ~/ verbatim (no fallback)', () => {
        withHomeEnv(() => {
            expect(resolveSkillPath(fakeRepo, '~')).toBe(fakeHome);
            expect(resolveSkillPath(fakeRepo, '~/foo/bar.md'))
                .toBe(path.join(fakeHome, 'foo/bar.md'));
        });
    });
});

describe('rollbackLauncherWorktree', () => {
    function setupRepo(repo: string, branch: string, wt: string): { git: (args: string[], cwd?: string) => ReturnType<typeof spawnSync> } {
        mkdirSync(repo, { recursive: true });
        const git = (args: string[], cwd = repo) => spawnSync('git', args, { cwd, encoding: 'utf8' });
        git(['init', '-b', 'main', '-q']);
        writeFileSync(path.join(repo, 'README.md'), '# r');
        git(['add', '-A']);
        git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
        git(['worktree', 'add', '-b', branch, wt]);
        return { git };
    }

    it('removes the worktree AND its branch with no residual ref (SEC-06 + SEC-FINAL-01)', () => {
        const sandbox = path.join(os.tmpdir(), `xtrm-rollback-${process.pid}`);
        const repo = path.join(sandbox, 'repo');
        const wt = path.join(repo, '.xtrm', 'worktrees', 'demo');
        const { git } = setupRepo(repo, 'xt/demo', wt);
        expect(existsSync(wt)).toBe(true);
        expect(git(['rev-parse', '--verify', 'refs/heads/xt/demo']).status).toBe(0);
        try {
            // deleteBranch=true: THIS invocation created the branch.
            rollbackLauncherWorktree(repo, wt, 'xt/demo', true);
            expect(existsSync(wt)).toBe(false);
            expect(git(['rev-parse', '--verify', 'refs/heads/xt/demo']).status).not.toBe(0);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });

    it('preserves a pre-existing reused branch when rollback runs (SEC-FINAL-01)', () => {
        const sandbox = path.join(os.tmpdir(), `xtrm-rollback-reuse-${process.pid}`);
        const repo = path.join(sandbox, 'repo');
        const wt = path.join(repo, '.xtrm', 'worktrees', 'demo');
        const { git } = setupRepo(repo, 'xt/demo', wt);
        // A second worktree reuses the SAME branch (launcher reuse mode).
        const wt2 = path.join(repo, '.xtrm', 'worktrees', 'demo2');
        git(['worktree', 'add', wt2, 'xt/demo']);
        expect(existsSync(wt)).toBe(true);
        const before = git(['rev-parse', 'refs/heads/xt/demo']);
        try {
            // deleteBranch=false: the branch pre-existed; a provisioning
            // failure of THIS invocation must not delete it.
            rollbackLauncherWorktree(repo, wt, 'xt/demo', false);
            expect(existsSync(wt)).toBe(false);
            expect(git(['rev-parse', '--verify', 'refs/heads/xt/demo']).status).toBe(0);
            expect(git(['rev-parse', 'refs/heads/xt/demo']).stdout).toBe(before.stdout);
        } finally {
            rmSync(sandbox, { recursive: true, force: true });
        }
    });
});
