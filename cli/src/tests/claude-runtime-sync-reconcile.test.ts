import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeProjectOwnedHooks, reconcileGlobalClaudeHooks, reconcileProjectClaudeHooks, resolveHooksForGlobalRuntime, runClaudeRuntimeSyncPhase } from '../core/claude-runtime-sync.js';

// reconcileProjectClaudeHooks resolves the canonical hooks.json from the package root
// (the xtrm-tools repo root in tests, via __dirname walk), then rewrites the project's
// .claude/settings.json hooks section. These tests exercise the xtrm-0p7bp guarantee:
// newly-shipped xtrm-managed hooks (e.g. service-skills) get wired into an existing
// consumer settings.json on apply, idempotently, without clobbering other keys.

let repoRoot = '';
let fakeHome = '';
let realHome: string | undefined;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-reconcile-test-'));
  fs.ensureDirSync(path.join(repoRoot, '.xtrm', 'hooks'));
  // xtrm-v1yck: reconcile now prunes registrations the global install already
  // covers, so these tests must not read the developer's real ~/.claude/settings.json.
  // An empty fake home makes the dedupe fail open — canonical hooks stay put.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-reconcile-home-'));
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.removeSync(fakeHome);
  fs.removeSync(repoRoot);
});

type Wrapper = { matcher?: string; hooks: Array<{ type?: string; command: string }> };

// Promote the written project settings hooks to a byte-identical fake global
// install: registrations re-pointed at the fake global hooks dir, plus the same
// hook files materialised under both dirs. Mirrors the production steady state
// where the global install covers every canonical registration.
function seedGlobalBaselineFromProjectSettings(projectHooks: Record<string, Wrapper[]>, homeDir: string): void {
  const projectHooksDir = path.join(repoRoot, '.xtrm', 'hooks');
  const globalHooksDir = path.join(homeDir, '.xtrm', 'hooks');
  const toGlobal = (s: string): string => s.split(projectHooksDir).join(globalHooksDir);
  const globalHooks: Record<string, unknown[]> = {};
  for (const [event, wrappers] of Object.entries(projectHooks)) {
    globalHooks[event] = wrappers.map((w) => ({
      matcher: w.matcher,
      hooks: w.hooks.map((h) => ({ type: 'command', command: toGlobal(h.command) })),
    }));
  }
  fs.ensureDirSync(path.join(homeDir, '.claude'));
  fs.writeJsonSync(path.join(homeDir, '.claude', 'settings.json'), { hooks: globalHooks });
  for (const [, wrappers] of Object.entries(projectHooks)) {
    for (const w of wrappers) {
      for (const h of w.hooks) {
        const rel = path.relative(projectHooksDir, h.command.replace(/^node "|"$/g, '').replace(/^python3 "/, ''));
        if (!rel || rel.startsWith('..')) continue;
        fs.ensureDirSync(path.dirname(path.join(globalHooksDir, rel)));
        fs.writeFileSync(path.join(globalHooksDir, rel), 'global-copy');
        fs.ensureDirSync(path.dirname(path.join(projectHooksDir, rel)));
        fs.writeFileSync(path.join(projectHooksDir, rel), 'global-copy');
      }
    }
  }
}

// Steady-state fixture: reconcile against an empty global baseline (fail-open)
// writes the full canonical set, then that set is promoted to a byte-identical
// fake global install. After this the global install covers every canonical
// registration — the state the machine-wide cleanup produced.
async function wireGlobalBaseline(): Promise<Record<string, Wrapper[]>> {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
  fs.ensureDirSync(path.dirname(settingsPath));
  fs.writeJsonSync(settingsPath, { hooks: {} });
  const first = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });
  expect(first.changed).toBe(true);
  expect(first.skippedGloballyCovered ?? 0).toBe(0);
  const canonicalWritten = fs.readJsonSync(settingsPath).hooks as Record<string, Wrapper[]>;
  expect(Object.keys(canonicalWritten).length).toBeGreaterThan(0);
  seedGlobalBaselineFromProjectSettings(canonicalWritten, fakeHome);
  return canonicalWritten;
}

describe('reconcileProjectClaudeHooks', () => {
  it('wires canonical hooks into an existing settings.json with no hooks, preserving other keys', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, {
      permissions: { allow: ['Bash(ls:*)'], defaultMode: 'default' },
      model: 'claude-opus-4-8',
      hooks: {},
    });

    const result = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

    expect(result.changed).toBe(true);
    const written = fs.readJsonSync(settingsPath);
    // Non-hook keys preserved
    expect(written.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(written.model).toBe('claude-opus-4-8');
    // Hooks section now populated from canonical
    expect(Object.keys(written.hooks).length).toBeGreaterThan(0);
    const allCommands = JSON.stringify(written.hooks);
    expect(allCommands).not.toContain('skill_activator');
    expect(allCommands).not.toContain('cataloger');
    expect(allCommands).not.toContain('drift_detector');
  });

  it('is idempotent: a second run reports no change', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, { hooks: {} });

    const first = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });
    expect(first.changed).toBe(true);

    const second = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });
    expect(second.changed).toBe(false);
  });

  it('dry-run reports the change without writing', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, { hooks: {} });

    const result = await reconcileProjectClaudeHooks(repoRoot, { dryRun: true });

    expect(result.changed).toBe(true);
    // Settings file untouched (still empty hooks)
    const written = fs.readJsonSync(settingsPath);
    expect(written.hooks).toEqual({});
  });

  // xtrm-61cdl (xtmux-qa0): reconcile must preserve third-party hooks the operator
  // (or another integration like xtmux auto-monitor) added to settings.json.
  // The previous wholesale-replace ate xtmux auto-monitor three times in a week.
  it('preserves third-party PreToolUse wrappers verbatim (xtrm-61cdl)', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    const thirdParty = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node /home/dawid/dev/xtmux/bin/auto-monitor.mjs' }],
    };
    fs.writeJsonSync(settingsPath, {
      permissions: { allow: [], defaultMode: 'default' },
      hooks: { PreToolUse: [thirdParty] },
    });

    await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

    const written = fs.readJsonSync(settingsPath);
    const preToolUse = written.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const thirdPartyCommand = preToolUse.flatMap((w) => w.hooks.map((h) => h.command));
    expect(thirdPartyCommand).toContain('node /home/dawid/dev/xtmux/bin/auto-monitor.mjs');
    // Canonical xtrm hooks still present alongside.
    const allCommands = JSON.stringify(written.hooks);
    expect(allCommands).not.toContain('skill_activator');
  });

  it('skips generated hooks already covered by the global install (global-only direction)', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    await wireGlobalBaseline();

    // Second run with full global coverage writes nothing project-scoped.
    fs.writeJsonSync(settingsPath, { hooks: {} });
    const second = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });
    expect((second.skippedGloballyCovered ?? 0)).toBeGreaterThan(0);
    const rewritten = fs.readJsonSync(settingsPath).hooks;
    expect(Object.keys(rewritten).length).toBe(0);
  });

  it('preserves foreign hooks under reconcile + dedupe when the global install covers canonical (xtrm-17gv0)', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const canonicalWritten = await wireGlobalBaseline();

    // Existing project settings carry the pre-cleanup canonical residue next to
    // a foreign wrapper. Reconcile must drop the globally-covered canonical
    // registrations and keep the foreign wrapper verbatim.
    const foreign = {
      matcher: 'Bash',
      hooks: [{ type: 'command' as const, command: 'node /home/dawid/dev/xtmux/bin/auto-monitor.mjs' }],
    };
    fs.writeJsonSync(settingsPath, { hooks: { ...canonicalWritten, PreToolUse: [foreign] } });

    const result = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

    expect(result.changed).toBe(true);
    expect(Number(result.skippedGloballyCovered ?? 0)).toBeGreaterThan(0);
    const after = fs.readJsonSync(settingsPath);
    const commands = (Object.values(after.hooks) as Wrapper[][]).flatMap((ws) => ws.flatMap((w) => w.hooks.map((h) => h.command)));
    expect(commands).toContain('node /home/dawid/dev/xtmux/bin/auto-monitor.mjs');
    // No project-scoped canonical registration survives — covered globally, so
    // neither the guard nor the dedupe (nor the merge) re-writes it.
    expect(commands.filter((c) => c.includes(path.join(repoRoot, '.xtrm', 'hooks')))).toHaveLength(0);
  });

  it('sync path skips globally-covered hooks and preserves foreign hooks (xtrm-17gv0)', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const canonicalWritten = await wireGlobalBaseline();

    // Pre-cleanup residue + a foreign wrapper. The sync path (runClaudeRuntimeSyncPhase,
    // isGlobal=false) must apply the same globally-covered guard as reconcile: the
    // covered canonical residue is dropped and not re-added, the foreign wrapper stays.
    const foreign = {
      matcher: 'Bash',
      hooks: [{ type: 'command' as const, command: 'node /home/dawid/dev/xtmux/bin/auto-monitor.mjs' }],
    };
    fs.writeJsonSync(settingsPath, { hooks: { ...canonicalWritten, PreToolUse: [foreign] } });

    const result = await runClaudeRuntimeSyncPhase({ repoRoot, dryRun: false, isGlobal: false });

    expect(result.wroteSettings).toBe(true);
    const after = fs.readJsonSync(settingsPath);
    const commands = (Object.values(after.hooks) as Wrapper[][]).flatMap((ws) => ws.flatMap((w) => w.hooks.map((h) => h.command)));
    expect(commands).toContain('node /home/dawid/dev/xtmux/bin/auto-monitor.mjs');
    expect(commands.filter((c) => c.includes(path.join(repoRoot, '.xtrm', 'hooks')))).toHaveLength(0);
  });

  it('drops a stale xtrm-managed wrapper whose hash no longer matches canonical (xtrm-61cdl)', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    // Simulate the retired service-skills PreToolUse hook. It must not survive
    // reconciliation after the Claude policy is removed.
    const stale = {
      matcher: 'Read|Write|Edit|Glob|Grep|Bash',
      hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/skills/service-skills/scripts/skill_activator.py"' }],
    };
    fs.writeJsonSync(settingsPath, { hooks: { PreToolUse: [stale] } });

    await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

    const written = fs.readJsonSync(settingsPath);
    const allCommands = JSON.stringify(written.hooks);
    expect(allCommands).not.toContain('skill_activator');
  });
});

// Direct unit tests on the merge helper — cover ownership detection without a
// package-root read. Ensures hash-match, path-containment, and third-party
// preservation all work as documented.
describe('mergeProjectOwnedHooks', () => {
  const canonical = {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/worktree-boundary.mjs' }],
      },
    ],
    SessionStart: [
      {
        hooks: [{ type: 'command' as const, command: 'sh -c \'p="$HOME/.xtrm/skills/default/service-skills/scripts/cataloger.py"; [ -f "$p" ] && python3 "$p"; exit 0\'' }],
      },
    ],
  };

  it('keeps canonical hooks when existing is empty', () => {
    const merged = mergeProjectOwnedHooks({}, canonical, '/repo/.xtrm/hooks');
    expect(merged.PreToolUse).toHaveLength(1);
    expect(merged.SessionStart).toHaveLength(1);
  });

  it('preserves an unrelated third-party hook and adds canonical alongside', () => {
    const existing = {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command' as const, command: 'node /home/dawid/dev/xtmux/bin/auto-monitor.mjs' }],
      }],
    };
    const merged = mergeProjectOwnedHooks(existing, canonical, '/repo/.xtrm/hooks');
    const commands = merged.PreToolUse.flatMap((w) => w.hooks.map((h) => h.command));
    expect(commands).toContain('node /home/dawid/dev/xtmux/bin/auto-monitor.mjs');
    expect(commands).toContain('node /repo/.xtrm/hooks/worktree-boundary.mjs');
  });

  // CORE-2339: upgrading a project that already carries the superseded
  // per-hook registrations must not leave them behind next to the dispatcher —
  // that would silently restore the process fan-out this change removes.
  it('drops superseded per-hook xt registrations when the dispatcher arrives', () => {
    const existing = {
      PreToolUse: [
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/worktree-boundary.mjs' }] },
        { matcher: 'Agent', hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/specialists-agent-guard.mjs' }] },
      ],
      PostToolUse: [
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/quality-check.cjs' }] },
        { hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/xtrm-tool-logger.mjs' }] },
      ],
      SessionStart: [
        { hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/quality-check-env.mjs' }] },
      ],
    };
    const dispatcher = {
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Agent', hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/dispatch.mjs pre' }] }],
      PostToolUse: [{ hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/dispatch.mjs post' }] }],
      SessionStart: [{ hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/dispatch.mjs session' }] }],
    };

    const merged = mergeProjectOwnedHooks(existing, dispatcher, '/repo/.xtrm/hooks');
    const commands = Object.values(merged).flat().flatMap((w) => w.hooks.map((h) => h.command));

    expect(commands).toContain('node /repo/.xtrm/hooks/dispatch.mjs pre');
    expect(commands).toContain('node /repo/.xtrm/hooks/dispatch.mjs post');
    expect(commands).toContain('node /repo/.xtrm/hooks/dispatch.mjs session');
    for (const superseded of ['worktree-boundary.mjs', 'specialists-agent-guard.mjs', 'quality-check.cjs', 'xtrm-tool-logger.mjs', 'quality-check-env.mjs']) {
      expect(commands.filter(c => c.includes(superseded)), `${superseded} survived the upgrade`).toEqual([]);
    }
  });

  it('drops an existing hook whose hash matches the canonical (dedupes)', () => {
    const existing = {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command' as const, command: 'node /repo/.xtrm/hooks/worktree-boundary.mjs' }],
      }],
    };
    const merged = mergeProjectOwnedHooks(existing, canonical, '/repo/.xtrm/hooks');
    // Only one instance of the canonical hook — no duplicate.
    expect(merged.PreToolUse).toHaveLength(1);
  });

  it('drops a stale xtrm-managed hook (matches .xtrm/hooks/ prefix but different content)', () => {
    const existing = {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command' as const, command: 'node "/repo/.xtrm/hooks/renamed-old-hook.mjs"' }],
      }],
    };
    const merged = mergeProjectOwnedHooks(existing, canonical, '/repo/.xtrm/hooks');
    const commands = merged.PreToolUse.flatMap((w) => w.hooks.map((h) => h.command));
    expect(commands).not.toContain('node "/repo/.xtrm/hooks/renamed-old-hook.mjs"');
    expect(commands).toContain('node /repo/.xtrm/hooks/worktree-boundary.mjs');
  });

  it('drops a stale service-skills wrapper reference (matches .xtrm/skills/default/service-skills/scripts/)', () => {
    const existing = {
      SessionStart: [{
        hooks: [{ type: 'command' as const, command: 'python3 "$HOME/.xtrm/skills/default/service-skills/scripts/legacy_prehook.py"' }],
      }],
    };
    const merged = mergeProjectOwnedHooks(existing, canonical, '/repo/.xtrm/hooks');
    const commands = merged.SessionStart.flatMap((w) => w.hooks.map((h) => h.command));
    expect(commands).not.toContain('python3 "$HOME/.xtrm/skills/default/service-skills/scripts/legacy_prehook.py"');
    expect(commands.some((c) => c.includes('cataloger.py'))).toBe(true);
  });

  it('preserves an event that only has third-party hooks (no canonical for that event)', () => {
    const existing = {
      Stop: [{
        hooks: [{ type: 'command' as const, command: 'node /home/dawid/scripts/my-shutdown-hook.mjs' }],
      }],
    };
    const merged = mergeProjectOwnedHooks(existing, canonical, '/repo/.xtrm/hooks');
    expect(merged.Stop).toHaveLength(1);
    expect(merged.Stop[0].hooks[0].command).toBe('node /home/dawid/scripts/my-shutdown-hook.mjs');
  });

  it('preserves third-party wrapper objects without hooks across resolution and merge', () => {
    const foreign = {
      matcher: 'Bash',
      provider: 'third-party',
    };
    const resolved = resolveHooksForGlobalRuntime(
      { PreToolUse: [foreign as never] },
      '/home/test/.xtrm/hooks',
    );
    expect(resolved.PreToolUse[0]).toEqual(foreign);

    const merged = mergeProjectOwnedHooks(
      { PreToolUse: [foreign as never] },
      canonical,
      '/repo/.xtrm/hooks',
    );
    expect(merged.PreToolUse).toContainEqual(foreign);
  });

  it('tolerates malformed hooks entries without crashing', () => {
    const existing = {
      PreToolUse: 'not-an-array' as unknown as Array<never>,
    };
    const merged = mergeProjectOwnedHooks(existing, canonical, '/repo/.xtrm/hooks');
    expect(merged.PreToolUse).toHaveLength(1);
  });
});

// XTRM-592 upgrade path: 0.14.0 registered agent-host-reporter.mjs as its own
// process on 8 events and inbox-reminder-stop.mjs on Stop. Both now run inside
// dispatch.mjs, so after the runtime sync reconciles an installed 0.14.0 neither
// may survive, or the event would run twice. The 0.14.0 side is the released
// hooks.json verbatim (fixtures/hooks-0.14.0.json, from 53e9a8c6), installed by
// the same reconcile code into a temp HOME.
describe('upgrade from 0.14.0 hooks (XTRM-592)', () => {
  const OLD_CONFIG = path.join(__dirname, 'fixtures', 'hooks-0.14.0.json');
  const NEW_CONFIG = path.resolve(__dirname, '../../../.xtrm/config/hooks.json');
  const RETIRED = ['agent-host-reporter.mjs', 'inbox-reminder-stop.mjs'];
  const EVENTS = ['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit'];

  const commandsByEvent = (hooks: Record<string, Wrapper[]>) =>
    Object.fromEntries(Object.entries(hooks).map(([event, ws]) => [event, ws.flatMap((w) => w.hooks.map((h) => h.command))]));

  it('global: reconcile replaces the installed 0.14.0 reporter and inbox entries with one dispatch.mjs per event', async () => {
    const configPath = path.join(fakeHome, '.xtrm', 'config', 'hooks.json');
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(configPath));
    fs.ensureDirSync(path.dirname(settingsPath));
    // A user hook on Stop must survive the upgrade untouched.
    const foreign = { hooks: [{ type: 'command', command: 'bash /home/user/.claude/hooks/xtmux/agent-state.sh done' }] };
    fs.writeJsonSync(settingsPath, { hooks: { Stop: [foreign] } });

    fs.copySync(OLD_CONFIG, configPath);
    await reconcileGlobalClaudeHooks({ dryRun: false });
    const installed = commandsByEvent(fs.readJsonSync(settingsPath).hooks);
    // The fixture really is the 0.14.0 shape: both retired hooks are wired.
    expect(installed.SessionEnd.join('\n')).toContain('agent-host-reporter.mjs');
    expect(installed.Stop.join('\n')).toContain('inbox-reminder-stop.mjs');

    fs.copySync(NEW_CONFIG, configPath);
    const upgrade = await reconcileGlobalClaudeHooks({ dryRun: false });
    expect(upgrade.changed).toBe(true);
    const after = commandsByEvent(fs.readJsonSync(settingsPath).hooks);
    const xtCommands = Object.fromEntries(
      Object.entries(after).map(([event, cs]) => [event, cs.filter((c) => c.includes(path.join(fakeHome, '.xtrm', 'hooks')))]),
    );
    for (const retired of RETIRED) expect(JSON.stringify(after)).not.toContain(retired);
    expect(Object.keys(xtCommands).sort()).toEqual(EVENTS);
    for (const event of EVENTS) {
      expect(xtCommands[event], event).toHaveLength(1);
      expect(xtCommands[event][0], event).toMatch(/dispatch\.mjs"? (pre|post|session|event)$/);
    }
    expect(after.Stop).toContain(foreign.hooks[0].command);

    // A second sync is a no-op: the upgrade converges.
    expect((await reconcileGlobalClaudeHooks({ dryRun: false })).changed).toBe(false);
  });

  it('project: reconcile drops the 0.14.0 reporter and inbox entries from .claude/settings.json', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const projectHooksDir = path.join(repoRoot, '.xtrm', 'hooks');
    const old = fs.readJsonSync(OLD_CONFIG).hooks as Record<string, Wrapper[]>;
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, { hooks: resolveHooksForGlobalRuntime(old, projectHooksDir) });

    await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

    const after = commandsByEvent(fs.readJsonSync(settingsPath).hooks);
    for (const retired of RETIRED) expect(JSON.stringify(after)).not.toContain(retired);
    expect(Object.keys(after).sort()).toEqual(EVENTS);
    for (const event of EVENTS) expect(after[event], event).toHaveLength(1);
  });
});
