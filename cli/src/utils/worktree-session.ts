import kleur from 'kleur';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync, lstatSync, readlinkSync, realpathSync, rmSync, readdirSync, accessSync, constants as fsConstants } from 'node:fs';

import { shouldUseGlobalSkills } from '../core/global-skills-flag.js';
import { ensureAgentsSkillsSymlink } from '../core/skills-scaffold.js';
import { isSafeRuntimeLinkName } from '../core/skills-state.js';
import { RESERVED_PACK_NAMES, resolveSkillsRoot, SKILL_FILE_NAME } from '../core/skills-layout.js';
import { runPiLaunchPreflight } from '../core/pi-runtime.js';
import { runtimeCompatibilityError } from '../core/runtime-compat.js';
import {
    buildDetachedLaunchOutcome,
    checkStructuredLaunchPaths,
    checkStructuredLaunchOptions,
    parseLiveTmuxSessionListing,
    sanitizeRuntimeVersion,
} from '../core/launch-outcome.js';

/**
 * Hard ceiling for the turn-1 shell command length. tmux new-session refuses
 * commands beyond a few dozen KB with "command too long"; keeping the sum of
 * systemPrompt + prefix + body under this bound guarantees a launchable pane.
 * xtrm-osipt (stopgap was file-based; xtrm-8zsi1 goes inline).
 */
const LITERAL_TURN1_BYTE_CEILING = 50 * 1024;
const RUNTIME_ARG_BYTE_CEILING = (128 * 1024) - 1;
const TMUX_CONSUMER_READY_TIMEOUT_MS = 5_000;
const TMUX_PAYLOAD_READY_TIMEOUT_MS = 5_000;
const RUNTIME_ORIGIN_SLUG_LENGTH = 5;
/**
 * Ceiling on the readiness handshake in assignBeadToRuntime — pi was measured
 * at ~11s from `tmux new-session` to `agent.ready`, so this is headroom around
 * a real signal, not the synchronization itself.
 */
const RUNTIME_READY_TIMEOUT_MS = 30_000;
const RUNTIME_READY_POLL_INTERVAL_MS = 500;
const RUNTIME_READY_QUERY_LIMIT = 20;
const AUTO_ASSIGNEE_RE = /^(?:pi|claude)\/[a-z0-9]{5}$/;

export function runtimeAssigneeFromOrigin(runtime: 'pi' | 'claude', runtimeOriginId: string): string | null {
    const tail = runtimeOriginId.trim().split(/[/:]/).filter(Boolean).at(-1);
    const slug = tail?.slice(0, RUNTIME_ORIGIN_SLUG_LENGTH).toLowerCase();
    return slug && /^[a-z0-9]{5}$/.test(slug) ? `${runtime}/${slug}` : null;
}

export function shouldAutoAssignBead(assignee: string | undefined): boolean {
    return !assignee || AUTO_ASSIGNEE_RE.test(assignee);
}

/**
 * Runtime instance id from the newest `agent.ready` row for `paneId`, or `''`
 * when the handshake has not landed yet. `null` means the journal cannot be
 * queried at all (no `xtmux` on PATH) — there is then no signal to wait for, so
 * the caller stops instead of burning the whole readiness budget.
 *
 * `xtmux log query --limit N` returns the newest N rows. Rows older than
 * `sinceMs`, and any row carrying the pane's previous occupant's id, are dropped
 * so neither a recycled `%N` pane id nor a restarted agent can resolve to a dead
 * instance.
 */
function readyInstanceId(
    paneId: string,
    sinceMs: number,
    previousInstanceId: string,
): string | null {
    const query = spawnSync('xtmux', [
        'log', 'query',
        '--type', 'agent.ready',
        '--pane', paneId,
        '--limit', String(RUNTIME_READY_QUERY_LIMIT),
        '--json',
    ], { encoding: 'utf8', stdio: 'pipe' });
    if (query.error) return null;
    if (query.status !== 0) return '';

    let rows: unknown;
    try {
        rows = JSON.parse(query.stdout ?? '');
    } catch {
        return '';
    }
    if (!Array.isArray(rows)) return '';

    let latest = '';
    let latestAt = -1;
    for (const row of rows as Array<{ createdAtMs?: unknown; instanceId?: unknown }>) {
        const at = typeof row?.createdAtMs === 'number' ? row.createdAtMs : -1;
        const id = typeof row?.instanceId === 'string' ? row.instanceId.trim() : '';
        if (!id || id === previousInstanceId || at < sinceMs || at <= latestAt) continue;
        latest = id;
        latestAt = at;
    }
    return latest;
}

export interface AssignBeadOptions {
    /** Instance id the pane carried before this launch; its `agent.ready` row must not win. */
    previousInstanceId?: string;
    /**
     * Reject `agent.ready` rows older than this epoch-ms. It guards a recycled `%N`
     * pane id whose journal still holds a previous occupation's row.
     *
     * MUST be captured before the runtime is started. Readiness is emitted exactly
     * once per occupation, so a watermark taken afterwards can reject the very row
     * this function is waiting for — and then there is no second one to catch, so
     * the launcher stalls for the whole timeout and skips the assignment. That is
     * the same failure this function exists to fix.
     */
    readyAfterMs?: number;
    readyTimeoutMs?: number;
}

export async function assignBeadToRuntime(
    bead: string,
    runtime: 'pi' | 'claude',
    paneId: string,
    cwd: string,
    options: AssignBeadOptions = {},
): Promise<void> {
    const {
        previousInstanceId = '',
        readyAfterMs = Date.now(),
        readyTimeoutMs = RUNTIME_READY_TIMEOUT_MS,
    } = options;
    const warn = (message: string): void => console.error(kleur.yellow(`  ⚠ bead assignee: ${message}`));
    const show = spawnSync('bd', ['show', bead, '--json'], { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (show.status !== 0) {
        warn(`could not read ${bead}; session launch continues`);
        return;
    }

    try {
        const beadData = JSON.parse(show.stdout ?? '') as Array<{ assignee?: string }> | { assignee?: string };
        const current = Array.isArray(beadData) ? beadData[0]?.assignee : beadData.assignee;
        if (!shouldAutoAssignBead(current)) return;
    } catch {
        warn(`invalid bd show output for ${bead}; session launch continues`);
        return;
    }

    // Synchronize on the runtime's own readiness handshake, NOT on the
    // `@agent_instance_id` pane option appearing.
    //
    // That option is written by xtmux's scripts/agent-state.sh from the runtime's
    // SessionStart hook, which for pi lands ~11s after `tmux new-session`. So
    // core#508's 5s poll of the bare option could never observe it and the
    // assignment silently never happened on `--role --bead` (xtrm-wiy5n.4.18).
    //
    // `agent.ready` is the handshake: agent-state.sh emits it exactly once per
    // agent occupation, only after the runtime has finished init and installed its
    // control hooks, and it carries the fresh instance id in the same row. Waiting
    // for that row — and rejecting one belonging to the pane's previous occupant —
    // is the same correlation rule xtmux's own `handoff --wait-ready` applies, so a
    // reused pane can never resolve to a dead agent's identity.
    const deadline = Date.now() + readyTimeoutMs;
    let instanceId: string | null = '';
    for (;;) {
        instanceId = readyInstanceId(paneId, readyAfterMs, previousInstanceId);
        if (instanceId === null) {
            warn(`xtmux unavailable, cannot resolve runtime-origin for ${bead}; session launch continues`);
            return;
        }
        if (instanceId || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, RUNTIME_READY_POLL_INTERVAL_MS));
    }

    const assignee = instanceId ? runtimeAssigneeFromOrigin(runtime, instanceId) : null;
    if (!assignee) {
        // Distinguish the two failure modes: diagnosing xtrm-wiy5n.4.18 started
        // from this warning's text, and "never readied" is a different bug from
        // "readied with an id we cannot slug".
        warn(instanceId
            ? `unusable runtime-origin '${instanceId}' for ${bead}; session launch continues`
            : `${runtime} did not signal readiness for ${bead} within ${Math.round(readyTimeoutMs / 1000)}s; session launch continues`);
        return;
    }

    const update = spawnSync('bd', ['update', bead, `--assignee=${assignee}`, '--json'], {
        cwd, encoding: 'utf8', stdio: 'pipe',
    });
    if (update.status !== 0) warn(`could not set ${bead} to ${assignee}; session launch continues`);
}

export interface WorktreeSessionOptions {
    runtime: 'claude' | 'pi';
    name?: string;
    role?: string;
    bead?: string;
    /** Explicit turn-1 body text (case ii). Mutually exclusive with --bead. */
    prompt?: string;
    attach?: boolean;
    /** Emit one xtrm.command-outcome.v1 object. Valid only with detached, non-reuse launches. */
    json?: boolean;
    /** Explicit runtime --model override; with --role, wins over the specialist default. */
    model?: string;
    /** Explicit Pi --thinking override; with --role, wins over the specialist default. */
    thinking?: string;
    /** Force a new tmux session even when inside $TMUX. Outside $TMUX this is the default. */
    newSession?: boolean;
    /** With --role: override @agent_parent_session on the target pane (tmux session name, id, or #{session_id}). */
    parent?: string;
    /** With --role: explicit form of the auto-behavior — @agent_parent_session = current pane's #{session_id}. --parent wins over --child when both set. */
    child?: boolean;
    /** Canonical subordinate-coordinator launch (audit P0-05). Expands to --new-session --no-attach --child. */
    subordinate?: boolean;
    /** When --new-session (or outside $TMUX) hits a session-name collision, attach to the existing session instead of auto-suffixing. */
    reuse?: boolean;
    /** Additional skills requested explicitly with repeatable --skill flags. */
    skills?: string[];
    /** Raw argv after `--` on the xt pi command; forwarded verbatim to pi. */
    passthrough?: string[];
}

function worktreeHasProjectUserPacks(worktreePath: string): boolean {
    const userPacksRoot = path.join(worktreePath, '.xtrm', 'skills', 'user', 'packs');
    if (!existsSync(userPacksRoot)) {
        return false;
    }

    return readdirSync(userPacksRoot).length > 0;
}

function verifyGlobalPointer(): void {
    const pointerPath = path.join(os.homedir(), '.claude', 'skills');
    const stat = lstatSync(pointerPath);
    if (!stat.isSymbolicLink()) {
        throw new Error(`global skills pointer is not a symlink: ${pointerPath}`);
    }

    const targetPath = readlinkSync(pointerPath);
    const resolvedTarget = path.resolve(path.dirname(pointerPath), targetPath);
    if (!existsSync(resolvedTarget)) {
        throw new Error(`global skills pointer target missing: ${resolvedTarget}`);
    }
}

export interface ResolvedRole {
    name: string;
    systemPrompt: string;
    skillPaths: string[];
    /** Surface-resolved specialist.execution.model default for this runtime. */
    model?: string;
    /** specialist.execution.thinking_level — default pi --thinking for role. */
    thinkingLevel?: string;
    /** specialist.execution.extensions — per-role opt-in/opt-out map. */
    extensions?: Record<string, boolean>;
    /** specialist.execution.interactive — role runs as a persistent session.
     * Tri-state: undefined means the installed Specialists release does not
     * declare it, which must stay permissive. xtrm-6hey0.3. */
    interactive?: boolean;
}

// Specialist configs — and the operator's ~/.config/specialists/user.json
// overrides — carry `provider/model` pairs for the pi/headless surface
// (qwencloud/qwen3.8-max-preview, openai-codex/gpt-5.4), and
// `sp view --surface claude` falls back to that generic execution.model whenever
// no execution.surface_models.claude is declared. The launcher is therefore the
// last place a foreign model can be caught: claude cannot run one, so forwarding
// it spawns a live tmux session whose claude dies at turn 1 ("issue with the
// selected model") — the worker never runs and an orchestrator waits forever.
//
// Detection is a denylist of *known* non-Anthropic vendors, deliberately not an
// allowlist of Claude names. A valid Claude identifier need not contain "claude"
// at all — Bedrock application-inference-profile ARNs, custom gateway ids — and
// `xt … --model` is documented (docs/xt-pi-role.md) to accept custom-provider
// identifiers, so anything unrecognised stays the operator's call. The vendor
// names are enumerated verbatim from pi's provider registry, regional and plan
// variants included — no suffix wildcard, so a Claude-compatible gateway that
// merely starts with a vendor word (`openai-compatible/…`, `google-proxy/…`)
// stays operator-controlled. Anthropic-capable hosts (anthropic, amazon-bedrock,
// google-vertex, the ai-gateways) are deliberately absent.
//
// Only the OUTER provider decides: `openrouter/anthropic/claude-sonnet-4.6` is
// an OpenRouter id that claude cannot run, whatever the nested model is named.
// A bare foreign name with no provider prefix (`gpt-5.4`) still passes — sp
// never emits one. xtrm-wiy5n.4.19.
const FOREIGN_MODEL_PROVIDERS: ReadonlySet<string> = new Set([
    'ant-ling', 'azure-openai-responses', 'cerebras', 'codex', 'copilot', 'deepseek',
    'fireworks', 'gemini', 'gemini-cli', 'github-copilot', 'glm', 'google', 'grok',
    'groq', 'huggingface', 'kimi', 'kimi-coding', 'llama', 'minimax', 'minimax-cn',
    'mistral', 'moonshot', 'moonshotai', 'moonshotai-cn', 'nano-gpt', 'nvidia',
    'ollama', 'openai', 'openai-codex', 'opencode', 'opencode-go', 'openrouter',
    'perplexity', 'qwen', 'qwen-cli', 'qwen-token-plan', 'qwen-token-plan-cn',
    'qwencloud', 'together', 'xai', 'xiaomi', 'xiaomi-token-plan-ams',
    'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
]);

export function isForeignProviderModel(model: string): boolean {
    const name = model.trim().toLowerCase();
    const slash = name.indexOf('/');
    if (slash <= 0) return false;
    return FOREIGN_MODEL_PROVIDERS.has(name.slice(0, slash));
}

// `xt claude … -- --model <name>` reaches claude through the passthrough tail
// instead of Commander, so the launcher's own --model preflight never sees it.
// Same value, same dead session. Every occurrence is returned: the tail is
// forwarded verbatim after the native --model, so a later one wins at the
// runtime and a safe native flag must not mask it. Exported for unit testing.
// xtrm-wiy5n.4.19.
export function passthroughModels(passthrough: readonly string[]): string[] {
    const models: string[] = [];
    for (let i = 0; i < passthrough.length; i++) {
        const arg = passthrough[i];
        // The operator's own end-of-options marker: everything after it is
        // positional text to the runtime, not a model selection.
        if (arg === '--') break;
        if (arg === '--model' && passthrough[i + 1] !== undefined) models.push(passthrough[i + 1]);
        else if (arg.startsWith('--model=')) models.push(arg.slice('--model='.length));
    }
    return models;
}

// The value the runtime actually selects: last `--model` wins, and the tail is
// appended after the native flag, so argv order is [native, ...passthrough].
// Only this one is worth validating — an earlier, overridden foreign value
// never reaches the model selection. xtrm-wiy5n.4.19.
export function effectiveModel(model: string | undefined, passthrough: readonly string[]): string | undefined {
    return [model, ...passthroughModels(passthrough)].filter((candidate): candidate is string => Boolean(candidate)).at(-1);
}

// xt-owned flags a passthrough must not clobber. Reject with a clear error if
// the user tries to pass any of these after `--`. Session naming, prompt, and
// session-dir are set by the launcher and re-passing them silently would break
// address routing or duplicate state.
const ROLE_GUARDED_PI_FLAGS: readonly string[] = [
    '--session-dir',
    '--name',
    '--system-prompt',
    '--append-system-prompt',
    '--skill',
] as const;

// Pi flags that contradict interactive coordination or invoke pi as a batch
// tool. Warn but drop rather than fail — the caller may have tried to reuse a
// script.
const ROLE_SKIPPED_PI_FLAGS: readonly string[] = [
    '--print',
    '--list-models',
    '--export',
    '--mode',
] as const;

export interface PiArgvGuardResult {
    guardedError?: string;
    warnings: string[];
    filteredArgs: string[];
}

// Pure — no I/O. Split so tests can drive it directly. Reached from every
// launch shape (pi/claude, role/bare) since xtrm-3xgs5, so the messages stay
// runtime- and mode-neutral.
export function guardRolePassthrough(passthrough: string[]): PiArgvGuardResult {
    const warnings: string[] = [];
    const filteredArgs: string[] = [];
    for (let i = 0; i < passthrough.length; i++) {
        const arg = passthrough[i];
        const bare = arg.split('=', 1)[0];
        if (ROLE_GUARDED_PI_FLAGS.includes(bare)) {
            return {
                guardedError: `passthrough: ${bare} is set by the launcher and cannot be passed after --`,
                warnings,
                filteredArgs: [],
            };
        }
        if (ROLE_SKIPPED_PI_FLAGS.includes(bare)) {
            warnings.push(`passthrough: ignoring ${bare} — incompatible with an interactive session`);
            // consume value if next arg is not another flag
            if (!arg.includes('=') && i + 1 < passthrough.length && !passthrough[i + 1].startsWith('-')) {
                i += 1;
            }
            continue;
        }
        filteredArgs.push(arg);
    }
    return { warnings, filteredArgs };
}

// Resolve a specialist.skills.paths entry to an absolute file path.
//
// Precedence, matching the operator's mental model "try local override,
// else canonical global":
//   1. absolute or ~-prefixed → use verbatim (author knows what they want)
//   2. relative + exists at mainRepoRoot → repo-local override
//   3. relative + exists at $HOME → canonical global (post-migration home)
//   4. otherwise → return the repo-resolved path so pi produces the loud
//      "skill not found" error at the exact absolute location the operator
//      can then fix
//
// Canonical global skills now live at ~/.xtrm/skills/default with runtime
// pointers at ~/.pi/agent/skills and ~/.claude/skills. Keep a narrow fallback
// for vendored specialist specs that still name the retired active tree.
// Exported for unit testing.
export function resolveSkillPath(mainRepoRoot: string, rawPath: string): string {
    if (path.isAbsolute(rawPath)) return rawPath;
    if (rawPath === '~') return os.homedir();
    if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2));
    const repoResolved = path.resolve(mainRepoRoot, rawPath);
    if (existsSync(repoResolved)) return repoResolved;
    const homeResolved = path.resolve(os.homedir(), rawPath);
    if (existsSync(homeResolved)) return homeResolved;
    const migratedPath = rawPath.replace(/^\.xtrm\/skills\/active\//, '.xtrm/skills/default/');
    const migratedResolved = path.resolve(os.homedir(), migratedPath);
    if (migratedPath !== rawPath && existsSync(migratedResolved)) return migratedResolved;
    return repoResolved;
}

// Bare logical name → v2 project-pack resolution seam (xtrm-lk07w.14). The
// repo layout flattens consumer-owned skills to <root>/.xtrm/skills/<pack>/<skill>/,
// with pack names varying per repository. Mirrors the flat-pack shape used by
// discoverRepoPacks in core/skill-discovery.ts (direct child packs of the
// .xtrm/skills root, reserved tier names excluded), without its async PACK.json
// metadata walk: launch resolution is synchronous and existence-bounded. Returns
// the sole matching SKILL.md, null when no pack owns the name. Multiple matches
// fail deterministically — first-match by filesystem order is never acceptable.

function errnoCode(error: unknown): string | undefined {
    return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

/** True only for a genuinely absent target. ENOTDIR is a layout violation, not
 * absence: an existing non-directory at a slot must fail loudly. */
function isEnoent(error: unknown): boolean {
    return errnoCode(error) === 'ENOENT';
}

function isPathInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Replace C0/C1 control bytes and ESC with escaped forms in diagnostics so a
 * hostile skill/pack name can never inject terminal control into an error. */
function sanitizeDiagnosticName(value: string): string {
    const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
        return `\\u{${ch.charCodeAt(0).toString(16).padStart(2, '0')}}`;
    });
    return escaped.length > 256 ? `${escaped.slice(0, 256)}…` : escaped;
}

function describeSkillRequest(mainRepoRoot: string, skill: string): string {
    if (!path.isAbsolute(skill)) return sanitizeDiagnosticName(skill);
    const relative = path.relative(mainRepoRoot, skill);
    return sanitizeDiagnosticName(isPathInside(skill, mainRepoRoot) ? relative : path.basename(skill));
}

/**
 * Validate the v2 pack-skill slot against the canonical skills root, per the
 * accepted fail-closed contract: ONLY a genuinely absent skill directory
 * (ENOENT) is a no-match for the pack. Every existing-but-malformed slot
 * throws a bounded, sanitized diagnostic: the slot being a file/symlink, a
 * missing/symlink/non-regular SKILL.md, an unreadable SKILL.md, or a SKILL.md
 * whose canonical location escapes the consumer skills root. Returns the
 * SKILL.md path only for the fully valid case.
 */
function probePackSkillDir(
    skillDir: string,
    skillFile: string,
    canonicalSkillsRoot: string,
    describe: string,
): string | null {
    let dirStat;
    try {
        dirStat = lstatSync(skillDir);
    } catch (error) {
        if (isEnoent(error)) return null; // genuine no-match: pack does not own the name
        throw new Error(`cannot probe project-pack skill '${sanitizeDiagnosticName(describe)}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    // An existing slot must be a real, non-symlink directory.
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new Error(
            `project-pack skill '${sanitizeDiagnosticName(describe)}' slot is not a real directory.`,
        );
    }
    // SKILL.md must exist as a regular file: a missing, symlinked, directory,
    // fifo, or other special SKILL.md is a violation, not a fallback signal.
    let fileStat;
    try {
        fileStat = lstatSync(skillFile);
    } catch (error) {
        if (isEnoent(error)) {
            throw new Error(`project-pack skill '${sanitizeDiagnosticName(describe)}' has no ${SKILL_FILE_NAME}.`);
        }
        throw new Error(`cannot probe ${SKILL_FILE_NAME} for project-pack skill '${sanitizeDiagnosticName(describe)}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error(
            `project-pack skill '${sanitizeDiagnosticName(describe)}' ${SKILL_FILE_NAME} is not a regular file.`,
        );
    }
    // Canonical containment: a symlinked skill dir / SKILL.md that escapes
    // .xtrm/skills is a violation, not a fallback signal.
    let canonicalFile;
    try {
        canonicalFile = realpathSync(skillFile);
    } catch (error) {
        throw new Error(`cannot canonicalize project-pack skill '${sanitizeDiagnosticName(describe)}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    if (!isPathInside(canonicalFile, canonicalSkillsRoot)) {
        throw new Error(`project-pack skill '${sanitizeDiagnosticName(describe)}' escapes the skills root.`);
    }
    try {
        accessSync(skillFile, fsConstants.R_OK);
    } catch (error) {
        throw new Error(`cannot read project-pack skill '${sanitizeDiagnosticName(describe)}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    return skillFile;
}

/**
 * Strict validation for a pack-root SKILL.md (and other optional skill files):
 * absence is a legitimate "no such skill here", but a present SKILL.md that is
 * a symlink, non-regular, unreadable, or escaping the skills root is a
 * violation and throws. Mirrors the fail-closed contract of probePackSkillDir
 * while allowing a pack container to exist without a root skill.
 */
function probeOptionalPackSkillFile(skillFile: string, canonicalSkillsRoot: string, describe: string): string | null {
    let stat;
    try {
        stat = lstatSync(skillFile);
    } catch (error) {
        if (isEnoent(error)) return null;
        throw new Error(`cannot probe project-pack skill '${sanitizeDiagnosticName(describe)}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
            `project-pack skill '${sanitizeDiagnosticName(describe)}' ${SKILL_FILE_NAME} is not a regular file.`,
        );
    }
    let canonicalFile;
    try {
        canonicalFile = realpathSync(skillFile);
    } catch (error) {
        throw new Error(`cannot canonicalize project-pack skill '${sanitizeDiagnosticName(describe)}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    if (!isPathInside(canonicalFile, canonicalSkillsRoot)) {
        throw new Error(`project-pack skill '${sanitizeDiagnosticName(describe)}' escapes the skills root.`);
    }
    try {
        accessSync(skillFile, fsConstants.R_OK);
    } catch (error) {
        throw new Error(`cannot read project-pack skill '${sanitizeDiagnosticName(describe)}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    return skillFile;
}

function resolveRepoPackSkill(mainRepoRoot: string, skillName: string): string | null {
    // A bare name is a single safe basename. Anything else cannot be a pack
    // skill reference and must keep its existing literal-path semantics.
    if (!isSafeRuntimeLinkName(skillName)) return null;
    const skillsRoot = resolveSkillsRoot(mainRepoRoot);
    let entries;
    try {
        entries = readdirSync(skillsRoot, { withFileTypes: true });
    } catch (error) {
        if (isEnoent(error)) return null; // repo has no .xtrm/skills at all
        // EACCES, EIO and ENOTDIR ('.xtrm/skills' is a file) are violations.
        throw new Error(`cannot enumerate project pack root '.xtrm/skills': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    let canonicalRepoRoot: string;
    let canonicalSkillsRoot: string;
    try {
        canonicalRepoRoot = realpathSync(mainRepoRoot);
        canonicalSkillsRoot = realpathSync(skillsRoot);
    } catch (error) {
        if (isEnoent(error)) return null;
        throw new Error(`cannot canonicalize project pack root '.xtrm/skills': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    // .xtrm/skills must stay inside the consumer checkout root; a skills root
    // that escapes it is a violation, not a fallback signal.
    if (!isPathInside(canonicalSkillsRoot, canonicalRepoRoot)) {
        throw new Error("project pack root '.xtrm/skills' escapes the consumer checkout root.");
    }
    const matches: ProjectPackSkillEntry[] = [];
    for (const entry of entries) {
        // Ordinary metadata files (state.json, INVARIANTS.md, ...) are skipped
        // by the directory check. A top-level non-reserved SYMLINK pack is a
        // layout violation and must fail loudly — never silently excluded
        // into a global fallback.
        if (entry.isSymbolicLink()) {
            if (!RESERVED_PACK_NAMES.has(entry.name)) {
                throw new Error(
                    `project pack '${sanitizeDiagnosticName(entry.name)}' at .xtrm/skills/${sanitizeDiagnosticName(entry.name)} is a symlink; packs must be real directories.`,
                );
            }
            continue;
        }
        if (!entry.isDirectory()) continue;
        if (RESERVED_PACK_NAMES.has(entry.name)) continue;
        const packPath = path.join(skillsRoot, entry.name);
        // Pack-root SKILL.md: optional (a pack container may hold only child
        // skills), but a present-and-malformed root skill is a violation. Its
        // runtime identity is the frontmatter name or, failing that, the pack
        // name.
        const rootSkill = probeOptionalPackSkillFile(
            path.join(packPath, SKILL_FILE_NAME),
            canonicalSkillsRoot,
            `${sanitizeDiagnosticName(entry.name)}/${SKILL_FILE_NAME}`,
        );
        if (rootSkill) {
            const runtimeName = readSkillRuntimeNameSync(rootSkill, entry.name);
            assertSafeRuntimeIdentity(runtimeName, `${sanitizeDiagnosticName(entry.name)}/${SKILL_FILE_NAME}`);
            // Canonical runtimeName OR the pack name (dirname semantics for a
            // root skill whose frontmatter renames it).
            if (runtimeName === skillName || entry.name === skillName) {
                matches.push({
                    runtimeName,
                    canonicalPath: realpathSync(rootSkill),
                    packName: entry.name,
                    repoRelativeDir: path.join('.xtrm', 'skills', entry.name),
                });
            }
        }
        // Direct child skill dirs, matched by canonical runtimeName (frontmatter
        // may differ from the directory basename, e.g. catalog -> name:
        // service-knowledge). A directory named exactly like the requested
        // skill that exists but is not a valid skill slot is a violation, not
        // a fallback signal; other child dirs without SKILL.md are not skills
        // and are skipped (canonical discovery parity).
        let children;
        try {
            children = readdirSync(packPath, { withFileTypes: true });
        } catch (error) {
            throw new Error(`cannot enumerate pack '.xtrm/skills/${sanitizeDiagnosticName(entry.name)}': ${errnoCode(error) ?? 'UnknownError'}`);
        }
        for (const child of children) {
            if (child.isSymbolicLink()) {
                if (child.name === skillName) {
                    throw new Error(
                        `project-pack skill '${sanitizeDiagnosticName(child.name)}' slot in pack '${sanitizeDiagnosticName(entry.name)}' is a symlink; must be a real directory.`,
                    );
                }
                continue;
            }
            if (!child.isDirectory()) {
                if (child.name === skillName) {
                    throw new Error(
                        `project-pack skill '${sanitizeDiagnosticName(child.name)}' slot in pack '${sanitizeDiagnosticName(entry.name)}' is not a real directory.`,
                    );
                }
                continue;
            }
            const slotDir = path.join(packPath, child.name);
            const slotFile = path.join(slotDir, SKILL_FILE_NAME);
            // SEC-FINAL-03: lstat the SKILL candidate — only a true ENOENT for
            // a non-requested child means "not a skill dir" (skip). A PRESENT
            // symlink (dangling or not), EACCES/EIO, or non-regular entry must
            // throw; an exact requested-name dir with no SKILL.md still throws.
            let slotStat;
            try {
                slotStat = lstatSync(slotFile);
            } catch (error) {
                if (isEnoent(error)) {
                    if (child.name === skillName) {
                        throw new Error(
                            `project-pack skill '${sanitizeDiagnosticName(child.name)}' slot in pack '${sanitizeDiagnosticName(entry.name)}' has no ${SKILL_FILE_NAME}.`,
                        );
                    }
                    continue; // genuinely absent: not a skill dir
                }
                throw new Error(`cannot probe ${SKILL_FILE_NAME} for pack '${sanitizeDiagnosticName(entry.name)}': ${errnoCode(error) ?? 'UnknownError'}`);
            }
            if (slotStat.isSymbolicLink() || !slotStat.isFile()) {
                throw new Error(
                    `project-pack skill '${sanitizeDiagnosticName(child.name)}' slot in pack '${sanitizeDiagnosticName(entry.name)}' ${SKILL_FILE_NAME} is not a regular file.`,
                );
            }
            const describe = `${sanitizeDiagnosticName(entry.name)}/${sanitizeDiagnosticName(child.name)}/${SKILL_FILE_NAME}`;
            const probed = probePackSkillDir(slotDir, slotFile, canonicalSkillsRoot, describe);
            if (!probed) continue;
            const runtimeName = readSkillRuntimeNameSync(slotFile, child.name);
            assertSafeRuntimeIdentity(runtimeName, describe);
            // Canonical runtimeName OR the slot directory basename: the dirname
            // arm preserves consumer layouts whose frontmatter renames the
            // skill (e.g. infra's service-knowledge/ dir with a longer name),
            // while the runtimeName arm resolves renamed children.
            if (runtimeName !== skillName && child.name !== skillName) continue;
            matches.push({
                runtimeName,
                canonicalPath: realpathSync(slotFile),
                packName: entry.name,
                repoRelativeDir: path.join('.xtrm', 'skills', entry.name, child.name),
            });
        }
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
        // Deterministic duplicate runtime-name detection (never first-match by
        // filesystem order).
        const owners = matches
            .map((match) => sanitizeDiagnosticName(match.repoRelativeDir))
            .sort((a, b) => a.localeCompare(b));
        throw new Error(
            `skill '${sanitizeDiagnosticName(skillName)}' is ambiguous: matches project packs '${owners.join("', '")}'. `
            + 'Enable one or pass an explicit path.',
        );
    }
    return matches[0].canonicalPath;
}

/**
 * Strict normalized pack direct: containment (canonical skills root inside the
 * canonical checkout root) FIRST, then the lstat probe (regular/readable/
 * canonical SKILL.md, dangling symlink fails), then the safe canonical
 * identity. Shared by lexically-pinned relative pack requests and absolute
 * pack-shaped directs; never falls back to the HOME tier (c7e/SEC-963).
 */
function probeResolvedPackDirect(mainRepoRoot: string, skill: string, direct: string): string {
    const describedSkill = describeSkillRequest(mainRepoRoot, skill);
    let canonicalSkillsRoot: string;
    try {
        const canonicalRepoRoot = realpathSync(mainRepoRoot);
        canonicalSkillsRoot = realpathSync(resolveSkillsRoot(mainRepoRoot));
        if (!isPathInside(canonicalSkillsRoot, canonicalRepoRoot)) {
            throw new Error("project pack root '.xtrm/skills' escapes the consumer checkout root.");
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('escapes the consumer checkout root')) throw error;
        if (isEnoent(error)) {
            throw new Error(`skill '${describedSkill}' is not a valid project-pack skill`);
        }
        throw new Error(`cannot canonicalize project pack root '.xtrm/skills': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    const skillDir = packSkillDir(direct);
    const slotFile = path.join(skillDir, SKILL_FILE_NAME);
    const probed = probePackSkillDir(
        skillDir,
        slotFile,
        canonicalSkillsRoot,
        sanitizeDiagnosticName(path.relative(mainRepoRoot, skillDir)),
    );
    if (!probed) {
        throw new Error(`skill '${describedSkill}' is not a valid project-pack skill`);
    }
    // Safe canonical identity required for every runtime (SEC-196-03).
    const entry = resolveProjectPackEntry(mainRepoRoot, direct);
    if (!entry) {
        throw new Error(`skill '${describedSkill}' is not a valid project-pack skill`);
    }
    // Return the canonical SKILL.md path (dir and file forms unify).
    return slotFile;
}

export function resolveRequestedSkills(
    mainRepoRoot: string,
    requested: string[],
    runtime: 'pi' | 'claude' | 'codex' = 'pi',
): string[] {
    // Runtime-targeted views (SEC-07): each runtime sees only its own enabled
    // runtime root, so a bare name can never resolve a Pi view for a Claude
    // launch and hide a valid project pack. Pi's home view is the agent
    // directory; claude/codex use their own roots.
    const repoView = runtime === 'pi' ? '.pi' : runtime === 'claude' ? '.claude' : '.agents';
    const homeView = runtime === 'pi' ? path.join('.pi', 'agent', 'skills') : path.join(repoView, 'skills');
    const resolved = requested.map((skill) => {
        // c7e: classify a RAW RELATIVE pack-shaped request LEXICALLY, pinned to
        // the main repo root, BEFORE resolveSkillPath's repo->$HOME fallback —
        // a missing repo pack must fail here and can never home-fallback into
        // matching HOME content. Absolute/~ requests keep the tiered behavior.
        const pinnedPackPath = !path.isAbsolute(skill) && !skill.startsWith('~')
            ? (isProjectPackShapePath(mainRepoRoot, path.resolve(mainRepoRoot, skill)) ? path.resolve(mainRepoRoot, skill) : null)
            : null;
        if (pinnedPackPath) {
            return probeResolvedPackDirect(mainRepoRoot, skill, pinnedPackPath);
        }
        const direct = resolveSkillPath(mainRepoRoot, skill);
        // SEC-FINAL-03 follow-up: pack-SHAPE routes through the strict probe
        // even when the target doesn't exist (dangling SKILL.md symlink) —
        // shape recognition is independent of existence.
        if (isProjectPackShapePath(mainRepoRoot, direct)) {
            return probeResolvedPackDirect(mainRepoRoot, skill, direct);
        }
        if (existsSync(direct)) {
            const valid = lstatSync(direct).isDirectory()
                ? existsSync(path.join(direct, 'SKILL.md'))
                : path.basename(direct) === 'SKILL.md';
            if (!valid) throw new Error(`skill '${describeSkillRequest(mainRepoRoot, skill)}' is not a skill directory or SKILL.md`);
            return direct;
        }

        // Enabled repo runtime-view precedes pack discovery: the operator's
        // explicit enablement resolves the name before any pack ambiguity can
        // arise. Never first-match; never shadow an enabled instance with an
        // unselected pack source.
        const repoRuntimeView = path.join(mainRepoRoot, repoView, 'skills', skill, SKILL_FILE_NAME);
        if (existsSync(repoRuntimeView)) return repoRuntimeView;

        // Project-pack tier precedes the global fallback: exactly one pack
        // match wins, multiple matches fail deterministically, zero continues.
        const repoPackSkill = resolveRepoPackSkill(mainRepoRoot, skill);
        const candidates = [
            ...(repoPackSkill ? [repoPackSkill] : []),
            path.join(os.homedir(), homeView, skill, SKILL_FILE_NAME),
            path.join(os.homedir(), '.xtrm', 'skills', 'default', skill, SKILL_FILE_NAME),
        ];
        const found = candidates.find(existsSync);
        if (!found) throw new Error(`skill '${describeSkillRequest(mainRepoRoot, skill)}' not found`);
        return found;
    });
    return [...new Set(resolved.map((skillPath) => realpathSync(skillPath)))];
}

// --- Claude pack-skill loadability (xtrm-lk07w.14) -----------------------
// Claude has no native --skill: a skill is loadable only as '/<name>' from a
// runtime root Claude discovers (<cwd>/.claude/skills or ~/.claude/skills).
// Project-pack skills live under <root>/.xtrm/skills/<pack>/ — not a runtime
// root — so the launcher materializes a bounded symlink for pack-tier skills
// inside the disposable worktree's .claude/skills after creation (the pane
// runs with cwd=worktreePath). No state.json writes: the link is
// worktree-local, non-managed (reap never touches it), and dies with the
// worktree on `xt end`.

export interface ProjectPackSkillEntry {
    /** Canonical runtime identity from SKILL.md frontmatter `name:` (fallback:
     * skill-dir basename, or pack name for a pack-root SKILL.md) — mirrors
     * skill-discovery.ts discoverSkill/discoverPackSkills semantics. */
    readonly runtimeName: string;
    /** realpath of the SKILL.md file in the main checkout. */
    readonly canonicalPath: string;
    readonly packName: string;
    /** Repo-relative directory of the skill slot, e.g.
     * `.xtrm/skills/infra/catalog` or `.xtrm/skills/infra` for a pack root. */
    readonly repoRelativeDir: string;
}

export interface ClaudePackSkillEntry extends ProjectPackSkillEntry {
    /** The '/<name>' this launch binds: the requested bare name when the slot
     * was resolved by name (including dirname-matched skills whose frontmatter
     * differs), the canonical runtimeName for explicit pack paths. */
    readonly name: string;
}

/** Pack-shaped resolved path forms: root skill file, child skill dir, child
 * skill file. Deeper descendants are never project-pack skills. */
/** Syntactic pack-shape recognition, INDEPENDENT of existence (SEC-FINAL-03
 * follow-up): a direct path under <root>/.xtrm/skills/<pack>/<skill> — even a
 * dangling SKILL.md symlink or a pack ROOT DIRECTORY — must still route
 * through the strict canonical probe instead of degrading to a generic
 * 'not found' (reviewer 751b HIGH). */
export function isProjectPackShapePath(mainRepoRoot: string, resolvedPath: string): boolean {
    const rel = path.relative(mainRepoRoot, resolvedPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const segments = rel.split(path.sep);
    if (segments[0] !== '.xtrm' || segments[1] !== 'skills') return false;
    if (segments.length === 3) return !RESERVED_PACK_NAMES.has(segments[2]); // pack root DIRECTORY
    if (segments.length === 4 && segments[3] === SKILL_FILE_NAME) return true; // pack-root skill file
    if (segments.length === 4) return !RESERVED_PACK_NAMES.has(segments[2]);    // child dir
    if (segments.length === 5 && segments[4] === SKILL_FILE_NAME) return !RESERVED_PACK_NAMES.has(segments[2]); // child file
    return false;
}

export function isProjectPackSkillPath(mainRepoRoot: string, resolvedPath: string): boolean {
    if (!isProjectPackShapePath(mainRepoRoot, resolvedPath)) return false;
    const rel = path.relative(mainRepoRoot, resolvedPath).split(path.sep);
    const packName = rel[2];
    const isRootForm = rel.length === 3 || (rel.length === 4 && rel[3] === SKILL_FILE_NAME);
    const slot = isRootForm
        ? path.join(mainRepoRoot, '.xtrm', 'skills', packName, SKILL_FILE_NAME)
        : path.join(mainRepoRoot, '.xtrm', 'skills', packName, rel[3], SKILL_FILE_NAME);
    return existsSync(slot);
}

/** Canonical runtime name of a SKILL.md, mirroring skill-discovery.ts's
 * readSkillFrontmatterName/discoverSkill semantics EXACTLY: reads the full
 * file (no truncation — the probe already established regularity/readability;
 * a concurrent read failure after that must NOT silently rename identity, so
 * it fails closed with a sanitized diagnostic). Frontmatter `name:` wins,
 * otherwise null (callers apply the dir/pack-name fallback). */
function readSkillFrontmatterNameSync(skillFile: string): string | null {
    let content: string;
    try {
        content = readFileSync(skillFile, { encoding: 'utf8' });
    } catch (error) {
        throw new Error(`cannot read project-pack skill frontmatter at '${sanitizeDiagnosticName(path.basename(path.dirname(skillFile)))}': ${errnoCode(error) ?? 'UnknownError'}`);
    }
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) return null;
    const nameLine = frontmatter[1].split(/\r?\n/).find((line) => /^name\s*:/.test(line));
    if (!nameLine) return null;
    return nameLine.replace(/^name\s*:/, '').trim().replace(/^["']|["']$/g, '').trim() || null;
}

function readSkillRuntimeNameSync(skillFile: string, fallbackName: string): string {
    return readSkillFrontmatterNameSync(skillFile) ?? fallbackName;
}

/**
 * Enforce a safe runtime identity (SEC-NEW follow-up): frontmatter names with
 * separators, dot segments, C0/C1/ESC controls, or other slash-unsafe content
 * must never resolve, alias, link, or match — bounded escaped diagnostics.
 * Strictly mirrors discoverSkill's assertSafeRuntimeLinkName and additionally
 * rejects control bytes so pi and claude aliases stay injection-free.
 */
function assertSafeRuntimeIdentity(runtimeName: string, describe: string): void {
    if (!isSafeRuntimeName(runtimeName) || !isSafeRuntimeLinkName(runtimeName)) {
        throw new Error(
            `project-pack skill '${sanitizeDiagnosticName(describe)}' declares unsafe runtime name '${sanitizeDiagnosticName(runtimeName)}'.`,
        );
    }
}

/** Normalize a resolved pack path to its skill directory (either form). */
function packSkillDir(resolvedPath: string): string {
    return path.basename(resolvedPath) === SKILL_FILE_NAME
        ? path.dirname(resolvedPath)
        : resolvedPath;
}

/** Structured canonical entry for any pack-shaped resolved path (runtimeName
 * read from frontmatter, never reconstructed from the directory basename). */
export function resolveProjectPackEntry(mainRepoRoot: string, resolvedPath: string): ProjectPackSkillEntry | null {
    if (!isProjectPackSkillPath(mainRepoRoot, resolvedPath)) return null;
    const rel = path.relative(mainRepoRoot, resolvedPath).split(path.sep);
    const isRootForm = rel.length === 3 || (rel.length === 4 && rel[3] === SKILL_FILE_NAME);
    const packName = rel[2];
    const skillFile = isRootForm
        ? path.join(mainRepoRoot, '.xtrm', 'skills', packName, SKILL_FILE_NAME)
        : path.join(mainRepoRoot, '.xtrm', 'skills', packName, rel[3], SKILL_FILE_NAME);
    if (!existsSync(skillFile)) return null;
    const fallback = isRootForm ? packName : rel[3];
    const runtimeName = readSkillRuntimeNameSync(skillFile, fallback);
    const describe = isRootForm
        ? path.join('.xtrm', 'skills', packName, SKILL_FILE_NAME)
        : path.join('.xtrm', 'skills', packName, rel[3], SKILL_FILE_NAME);
    assertSafeRuntimeIdentity(runtimeName, describe);
    return {
        runtimeName,
        canonicalPath: realpathSync(skillFile),
        packName,
        repoRelativeDir: isRootForm
            ? path.join('.xtrm', 'skills', packName)
            : path.join('.xtrm', 'skills', packName, rel[3]),
    };
}

/**
 * Deterministic claude identity binding (security fa12): for each canonical
 * pack identity, the bound '/<name>' NEVER depends on request order. Policy:
 * prefer the safe slot-dir/pack alias when ANY request names it (needed for
 * the real infra layout where the declaration names the slot dir), else the
 * sole requested name, else the canonical runtimeName; requests that name one
 * identity with several different names are rejected deterministically. Role
 * declarations carry the sp prefix name per declaration (sp resolves bare
 * declarations to slot paths, so the declared name only survives in the
 * prefix); explicit path requests contribute no name, bare requests do.
 */
export function bindClaudePackNames(
    mainRepoRoot: string,
    roleDecls: string[],
    rolePrefixNames: string[] | null,
    explicitRequests: string[],
    runtime: 'pi' | 'claude' | 'codex' = 'pi',
): { roleEntries: ClaudePackSkillEntry[]; explicitEntries: ClaudePackSkillEntry[] } {
    type Candidate = { entry: ProjectPackSkillEntry; names: Set<string>; roleOwned: boolean; explicitOwned: boolean };
    const candidates = new Map<string, Candidate>();

    const add = (raw: string, name: string | null, isExplicit: boolean): void => {
        if (typeof raw !== 'string' || !raw) return;
        const resolved = resolveRequestedSkills(mainRepoRoot, [raw], runtime)[0];
        const entry = resolved ? resolveProjectPackEntry(mainRepoRoot, resolved) : null;
        if (!entry) return;
        const bucket = candidates.get(entry.canonicalPath)
            ?? { entry, names: new Set<string>(), roleOwned: false, explicitOwned: false };
        if (isExplicit) bucket.explicitOwned = true;
        else bucket.roleOwned = true;
        if (name) bucket.names.add(name);
        candidates.set(entry.canonicalPath, bucket);
    };

    roleDecls.forEach((decl, i) => {
        const requestedName = rolePrefixNames ? rolePrefixNames[i] : null;
        const name = requestedName ?? (isSafeRuntimeLinkName(decl) && !path.isAbsolute(decl) && !decl.includes(path.sep) ? decl : null);
        add(decl, name, false);
    });
    explicitRequests.forEach((req) => {
        const name = isSafeRuntimeLinkName(req) && !path.isAbsolute(req) && !req.includes(path.sep) ? req : null;
        add(req, name, true);
    });

    const byName = (entry: ProjectPackSkillEntry): string => path.basename(entry.repoRelativeDir);
    const roleEntries: ClaudePackSkillEntry[] = [];
    const explicitEntries: ClaudePackSkillEntry[] = [];
    for (const bucket of candidates.values()) {
        const { entry, names } = bucket;
        const slotAlias = byName(entry);
        // Allowed-name policy (reviewer 78): a requested name must be the slot
        // alias or the canonical runtime name — ANY other alias rejects before
        // creation; slot wins when both are present, order-independently;
        // path-only requests (no requested name) keep canonical runtimeName
        // (approved explicit-path / old-sp contract — never force slot alias).
        for (const name of names) {
            if (name !== slotAlias && name !== entry.runtimeName) {
                throw new Error(
                    `project-pack skill '${sanitizeDiagnosticName(entry.repoRelativeDir)}' is requested under '${sanitizeDiagnosticName(name)}', `
                    + `which is neither its slot name '${sanitizeDiagnosticName(slotAlias)}' nor its canonical runtime name '${sanitizeDiagnosticName(entry.runtimeName)}'. `
                    + 'Remove the conflicting declaration.',
                );
            }
        }
        let bound: string;
        if (names.has(slotAlias)) {
            bound = slotAlias;
        } else if (names.has(entry.runtimeName)) {
            bound = entry.runtimeName;
        } else {
            bound = entry.runtimeName;
        }
        if (!isSafeRuntimeName(bound)) {
            throw new Error(
                `project-pack skill '${sanitizeDiagnosticName(entry.repoRelativeDir)}' has unsafe bound name '${sanitizeDiagnosticName(bound)}'.`,
            );
        }
        const named: ClaudePackSkillEntry = { ...entry, name: bound };
        // Independent ownership: an identity declared by the role belongs in
        // the ROLE block regardless of an explicit duplicate; only explicit-
        // only identities go to explicitEntries.
        if (bucket.roleOwned || !bucket.explicitOwned) roleEntries.push(named);
        else explicitEntries.push(named);
    }
    return { roleEntries, explicitEntries };
}

/**
 * Deduped explicit turn-1 lines: explicit identities already covered by the
 * role block (same canonical identity, coalesced bound name) are dropped, and
 * any explicit name already appearing in the role prefix is dropped — a
 * command is never emitted without ITS link, and never duplicated.
 */
export function composeClaudeExplicitLines(
    mainRepoRoot: string,
    explicitSkillPaths: string[],
    claudePackEntries: ClaudePackSkillEntry[],
    roleCommandNames: Set<string>,
): string {
    const lines = claudeExplicitLinesFor(mainRepoRoot, explicitSkillPaths, claudePackEntries)
        .split(/\r?\n/)
        .filter((line) => line.startsWith('/'));
    return lines
        .filter((line) => !roleCommandNames.has(line.slice(1)))
        .join('\n');
}

/**
 * Reconstruct the claude role command block so it carries exactly ONE command
 * per canonical identity (seconder ca9f): pack declarations are rewritten to
 * the deterministic bound name (duplicates for one identity are removed, even
 * when the sp prefix named them differently); non-pack declarations keep
 * their sp prefix name (or basename in the fallback) in declaration order.
 */
export function composeClaudeRoleBlock(
    mainRepoRoot: string,
    roleDecls: string[],
    spPrefixNames: string[] | null,
    roleEntries: ClaudePackSkillEntry[],
    runtime: 'pi' | 'claude' | 'codex' = 'pi',
): string {
    const entryByPath = new Map(roleEntries.map((entry) => [entry.canonicalPath, entry]));
    const emitted = new Set<string>();
    const lines: string[] = [];
    for (let i = 0; i < roleDecls.length; i += 1) {
        // SEC-02: resolve EACH declaration individually — resolveRequestedSkills
        // dedupes at the array level, which would corrupt raw-declaration index
        // alignment for duplicate alias declarations.
        let entry: ClaudePackSkillEntry | undefined;
        try {
            const resolved = resolveRequestedSkills(mainRepoRoot, [roleDecls[i]], runtime)[0];
            entry = resolved ? entryByPath.get(realpathSync(resolved)) : undefined;
        } catch {
            entry = undefined;
        }
        if (entry) {
            if (emitted.has(entry.canonicalPath)) continue; // duplicate identity: rewritten/removed
            emitted.add(entry.canonicalPath);
            lines.push(`/${entry.name}`);
            continue;
        }
        const name = spPrefixNames?.[i]
            ?? (path.basename(roleDecls[i]) === SKILL_FILE_NAME ? path.basename(path.dirname(roleDecls[i])) : path.basename(roleDecls[i]));
        lines.push(`/${name}`);
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`;
}

/** Safe slash-name check for runtime identities (claude link targets). */
function isSafeRuntimeName(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/** Logical slash name of a resolved project-pack skill path (SEC-03 uses it
 * for the codex unsupported-error message). */
export function projectPackSkillName(mainRepoRoot: string, resolvedPath: string): string | null {
    const entry = resolveProjectPackEntry(mainRepoRoot, resolvedPath);
    return entry && isSafeRuntimeName(entry.runtimeName) ? entry.runtimeName : null;
}

/**
 * Preflight gate for claude role-declared and explicit --skill paths that
 * resolved to a project pack. The pack path is not natively discoverable, so
 * the worktree link below carries loadability; what must fail here is a name
 * conflict that would make claude load a different skill than the one
 * requested — an occupied main-root slot with different content, or a
 * same-named user-global (v2 policy: user-global silently wins for claude,
 * so the pack skill would be shadowed). Applies to the combined
 * role-declared + operator-requested set, before worktree creation.
 */
/** Normalize gate/materializer inputs: strings resolve to their canonical
 * entry (name = runtimeName); structured entries carry the bound name. */
function normalizeClaudeEntry(
    mainRepoRoot: string,
    item: string | ClaudePackSkillEntry,
): ClaudePackSkillEntry | null {
    if (typeof item === 'string') {
        const entry = resolveProjectPackEntry(mainRepoRoot, item);
        return entry ? { ...entry, name: entry.runtimeName } : null;
    }
    return item;
}

export function assertClaudePackSkillsLoadable(mainRepoRoot: string, resolvedPaths: Array<string | ClaudePackSkillEntry>): void {
    // Pairwise identity guard (SEC-06 + SEC-NEW-02): every resolved pack skill
    // contributes its bound '/<name>' -> canonical identity; two different
    // identities for one bound name must fail before worktree creation.
    const identities = new Map<string, { identity: string; dir: string }>();
    for (const item of resolvedPaths) {
        const entry = normalizeClaudeEntry(mainRepoRoot, item);
        if (!entry) continue;
        const name = entry.name;
        if (!isSafeRuntimeName(name)) {
            throw new Error(
                `project pack skill in '${sanitizeDiagnosticName(entry.repoRelativeDir)}' declares unsafe runtime name '${sanitizeDiagnosticName(name)}'.`,
            );
        }
        const existing = identities.get(name);
        if (existing && existing.identity !== entry.canonicalPath) {
            const firstRel = sanitizeDiagnosticName(entry.repoRelativeDir);
            const secondRel = sanitizeDiagnosticName(existing.dir);
            throw new Error(
                `skill '/${sanitizeDiagnosticName(name)}' is declared from two different project packs `
                + `(${firstRel} vs ${secondRel}). Remove the duplicate declaration.`,
            );
        }
        identities.set(name, { identity: entry.canonicalPath, dir: entry.repoRelativeDir });
        const requestedFile = entry.canonicalPath;
        const mainSlotFile = path.join(mainRepoRoot, '.claude', 'skills', name, SKILL_FILE_NAME);
        if (existsSync(mainSlotFile)) {
            // Local slot: allowed only when it already resolves to the
            // requested skill; anything else would load different content.
            // Validating local first must never skip the global check.
            let localIsRequested = false;
            try {
                localIsRequested = realpathSync(mainSlotFile) === requestedFile;
            } catch {
                localIsRequested = false;
            }
            if (!localIsRequested) {
                throw new Error(
                    `skill '/${sanitizeDiagnosticName(name)}' resolves to a project pack but ${path.join(mainRepoRoot, '.claude', 'skills', name)} `
                    + 'already holds a different skill. Remove or rename that slot, then retry.',
                );
            }
        }
        // Always consulted, independent of the local slot outcome.
        const homeSlot = path.join(os.homedir(), '.claude', 'skills', name);
        if (existsSync(homeSlot)) {
            throw new Error(
                `skill '/${sanitizeDiagnosticName(name)}' resolves to a project pack but a same-named global skill exists at ${homeSlot}. `
                + 'Remove or rename the global skill, then retry.',
            );
        }
        // Divergent-name fail-safe (reviewer 7f5): when the bound alias differs
        // from the canonical runtimeName, claude could also load '/<runtimeName>'.
        // Occupied local/user-global namespace under the runtimeName is allowed
        // only when it holds the SAME canonical content — wrong content or an
        // occupied unknown slot must fail deterministically.
        if (name !== entry.runtimeName) {
            const canonicalSlotFile = path.join(mainRepoRoot, '.claude', 'skills', entry.runtimeName, SKILL_FILE_NAME);
            if (existsSync(canonicalSlotFile)) {
                let same = false;
                try { same = realpathSync(canonicalSlotFile) === entry.canonicalPath; } catch { same = false; }
                if (!same) {
                    throw new Error(
                        `skill '/${sanitizeDiagnosticName(name)}' resolves to a project pack whose canonical runtime name '${sanitizeDiagnosticName(entry.runtimeName)}' `
                        + `is occupied by a different skill at ${path.join(mainRepoRoot, '.claude', 'skills', entry.runtimeName)}. `
                        + 'Remove or rename that slot, then retry.',
                    );
                }
            }
            const canonicalHomeSlot = path.join(os.homedir(), '.claude', 'skills', entry.runtimeName);
            if (existsSync(canonicalHomeSlot)) {
                throw new Error(
                    `skill '/${sanitizeDiagnosticName(name)}' resolves to a project pack whose canonical runtime name '${sanitizeDiagnosticName(entry.runtimeName)}' `
                    + `is shadowed by a global skill at ${canonicalHomeSlot}. Remove or rename the global skill, then retry.`,
                );
            }
        }
    }
}

/**
 * Materialize worktree-local '.claude/skills/<runtimeName>' links for resolved
 * pack-tier skills so the claude pane (cwd=worktreePath) can load them as
 * '/<runtimeName>'. Link names and identities come from the canonical
 * SKILL.md frontmatter name, never the directory basename (SEC-NEW-02).
 * Required startup state: an occupied slot that does not already resolve to
 * the requested skill, or a same-named user-global slot, throws instead of
 * silently loading a different skill. Returns the created link paths.
 */
export function ensureClaudePackSkillLinks(worktreePath: string, mainRepoRoot: string, resolvedPaths: Array<string | ClaudePackSkillEntry>): string[] {
    const created: string[] = [];
    try {
        const seen = new Set<string>();
        for (const item of resolvedPaths) {
            const entry = normalizeClaudeEntry(mainRepoRoot, item);
            if (!entry) continue;
            if (seen.has(entry.canonicalPath)) continue;
            seen.add(entry.canonicalPath);
            const name = entry.name;
            if (!isSafeRuntimeName(name)) {
                throw new Error(
                    `cannot link pack skill in '${sanitizeDiagnosticName(entry.repoRelativeDir)}': unsafe runtime name '${sanitizeDiagnosticName(name)}'.`,
                );
            }
            // Same-skill user-global slot is still a shadow for claude (global
            // wins); the preflight gate rejects this before creation, and
            // materialization refuses it defensively as well.
            const homeSlot = path.join(os.homedir(), '.claude', 'skills', name);
            if (existsSync(homeSlot)) {
                throw new Error(
                    `cannot link pack skill '${sanitizeDiagnosticName(name)}' into the worktree: same-named user-global exists at ${homeSlot}. `
                    + 'Remove or rename the global skill, then retry.',
                );
            }
            // SEC-05: link the WORKTREE-LOCAL pack copy — the launched pane's
            // checkout is the session's immutable view; the main checkout stays
            // mutable and is never a link target.
            const wtSkillDir = path.join(worktreePath, entry.repoRelativeDir);
            const wtSkillFile = path.join(wtSkillDir, SKILL_FILE_NAME);
            // Divergent-name fail-safe (reviewer 7f5): the canonical runtimeName
            // namespace in the worktree must not hold different content.
            if (name !== entry.runtimeName) {
                const wtCanonicalSlot = path.join(worktreePath, '.claude', 'skills', entry.runtimeName, SKILL_FILE_NAME);
                if (existsSync(wtCanonicalSlot)) {
                    let same = false;
                    try { same = realpathSync(wtCanonicalSlot) === realpathSync(wtSkillFile); } catch { same = false; }
                    if (!same) {
                        throw new Error(
                            `cannot link pack skill '${sanitizeDiagnosticName(name)}': the worktree canonical runtime name '${sanitizeDiagnosticName(entry.runtimeName)}' `
                            + 'slot holds different content. Remove or rename that slot, then retry.',
                        );
                    }
                }
            }
            const wtSkillsRoot = resolveSkillsRoot(worktreePath);
            let wtRoot: string;
            let canonicalWtSkillsRoot: string;
            try {
                wtRoot = realpathSync(worktreePath);
                canonicalWtSkillsRoot = realpathSync(wtSkillsRoot);
            } catch (error) {
                if (isEnoent(error)) {
                    throw new Error(
                        `cannot link pack skill '${sanitizeDiagnosticName(name)}': the worktree does not contain .xtrm/skills. `
                        + 'Pack skills must be tracked so worktrees receive them.',
                    );
                }
                throw new Error(`cannot canonicalize the worktree skills root: ${errnoCode(error) ?? 'UnknownError'}`);
            }
            if (!isPathInside(canonicalWtSkillsRoot, wtRoot)) {
                throw new Error(
                    `cannot link pack skill '${sanitizeDiagnosticName(name)}': the worktree skills root escapes the worktree root.`,
                );
            }
            const describe = `${sanitizeDiagnosticName(entry.repoRelativeDir)}/${SKILL_FILE_NAME}`;
            // Shared fail-closed probe: absent worktree slot -> no match ->
            // 'must be tracked'; any malformed local copy throws its bounded
            // diagnostic (SEC-02/05).
            const probed = probePackSkillDir(wtSkillDir, wtSkillFile, canonicalWtSkillsRoot, describe);
            if (!probed) {
                throw new Error(
                    `cannot link pack skill '${sanitizeDiagnosticName(name)}': ${describe} is absent from the worktree. `
                    + 'Pack skills must be tracked so worktrees receive them.',
                );
            }
            // The worktree copy must carry the SAME canonical runtime identity;
            // a divergent copy would link the wrong skill under this name.
            const wtRuntimeName = readSkillRuntimeNameSync(wtSkillFile, path.basename(wtSkillDir));
            if (wtRuntimeName !== entry.runtimeName) {
                throw new Error(
                    `cannot link pack skill '${sanitizeDiagnosticName(name)}': the worktree copy at '${describe}' `
                    + `declares runtime name '${sanitizeDiagnosticName(wtRuntimeName)}'.`,
                );
            }
            const linkPath = path.join(worktreePath, '.claude', 'skills', name);
            if (existsSync(linkPath)) {
                // Occupied: allowed only when it already resolves to the
                // requested worktree skill; anything else would load a
                // different skill under the same '/<name>'.
                try {
                    const slotFile = path.join(linkPath, SKILL_FILE_NAME);
                    if (realpathSync(slotFile) === realpathSync(wtSkillFile)) {
                        continue;
                    }
                } catch {
                    // broken link or non-skill content: falls through to error
                }
                throw new Error(
                    `cannot link pack skill '${name}' into the worktree: ${path.join(worktreePath, '.claude', 'skills', name)} `
                    + 'already holds a different skill. Remove or rename that slot, then retry.',
                );
            }
            mkdirSync(path.dirname(linkPath), { recursive: true });
            // Symlink targets resolve relative to the link's own directory
            // (.claude/skills), not the worktree root.
            const target = path.relative(path.dirname(linkPath), wtSkillDir);
            symlinkSync(target, linkPath, 'dir');
            created.push(linkPath);
            // Verify link identity after creation and roll back on mismatch
            // (SEC-05/06): never leave a link that resolves elsewhere.
            try {
                if (realpathSync(path.join(linkPath, SKILL_FILE_NAME)) !== realpathSync(wtSkillFile)) {
                    unlinkSync(linkPath);
                    created.pop();
                    throw new Error(`pack skill link '${name}' failed identity verification and was removed.`);
                }
            } catch (error) {
                if (error instanceof Error && error.message.includes('failed identity verification')) throw error;
                unlinkSync(linkPath);
                created.pop();
                throw new Error(`pack skill link '${name}' failed identity verification and was removed: ${errnoCode(error) ?? 'UnknownError'}`);
            }
        }
        return created;
    } catch (error) {
        // Transactional rollback (SEC-06): remove any links this call created
        // before propagating — no orphan launcher-owned state.
        for (const link of created) {
            try { unlinkSync(link); } catch { /* best-effort */ }
        }
        throw error;
    }
}

export function assertClaudeSkillsDiscoverable(mainRepoRoot: string, requestedPaths: string[]): void {
    for (const requestedPath of requestedPaths) {
        const requestedFile = path.basename(requestedPath) === 'SKILL.md'
            ? requestedPath
            : path.join(requestedPath, 'SKILL.md');
        const name = path.basename(path.dirname(requestedFile));
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
            throw new Error(`invalid Claude skill name '${name}' from '${requestedPath}'`);
        }
        const candidates = [
            path.join(mainRepoRoot, '.claude', 'skills', name, 'SKILL.md'),
            path.join(os.homedir(), '.claude', 'skills', name, 'SKILL.md'),
        ];
        const requestedRealPath = realpathSync(requestedFile);
        if (candidates.some((candidate) => existsSync(candidate) && realpathSync(candidate) === requestedRealPath)) continue;
        throw new Error(
            `skill '${requestedPath}' is not discoverable by Claude as '/${name}'. `
            + `Install or enable the same skill under .claude/skills/${name} before launching.`,
        );
    }
}

// Exposed for unit testing. sp view <name> --raw is the source of truth for
// specialist resolution — do not reimplement its .specialists/user + installed
// package precedence here. Declared skill paths are returned verbatim (bare
// names and unresolved relatives stay raw): resolveRequestedSkills is the
// single resolver for role-declared and operator-requested skills, so a bare
// name like 'service-knowledge' can reach v2 project-pack discovery instead of
// being frozen into a nonexistent repo-resolved path at parse time.
export function parseSpecialistJson(name: string, raw: string, mainRepoRoot: string = process.cwd()): ResolvedRole {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`sp view ${name} --raw did not return JSON`);
    }
    const spec = (parsed as { specialist?: Record<string, unknown> } | null)?.specialist;
    if (!spec || typeof spec !== 'object') {
        throw new Error(`role '${name}': missing 'specialist' key in sp output`);
    }
    const promptSection = (spec as { prompt?: unknown }).prompt as { system?: unknown } | undefined;
    const systemPrompt = promptSection?.system;
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
        throw new Error(`role '${name}': specialist.prompt.system is empty`);
    }
    const skillsSection = (spec as { skills?: unknown }).skills as { paths?: unknown } | undefined;
    const rawPaths = skillsSection?.paths;
    const skillPaths = Array.isArray(rawPaths)
        ? rawPaths
            .filter((p): p is string => typeof p === 'string' && p.length > 0)
        : [];
    const mode = (spec as { system_prompt_mode?: unknown }).system_prompt_mode;
    if (mode === 'replace') {
        // Interactive pi must keep AGENTS.md + coding base. Warn and force append.
        process.stderr.write(kleur.yellow(
            `  ⚠ role '${name}': system_prompt_mode=replace ignored; forcing append\n`,
        ));
    }

    // execution.{model,thinking_level,extensions} — all optional. CLI flags win
    // over these at launch time; specialists set them as sensible defaults.
    const execution = (spec as { execution?: unknown }).execution as
        | { model?: unknown; thinking_level?: unknown; extensions?: unknown; interactive?: unknown }
        | undefined;
    const model = typeof execution?.model === 'string' && execution.model ? execution.model : undefined;
    const thinkingLevel = typeof execution?.thinking_level === 'string' && execution.thinking_level ? execution.thinking_level : undefined;
    let extensions: Record<string, boolean> | undefined;
    if (execution?.extensions && typeof execution.extensions === 'object' && !Array.isArray(execution.extensions)) {
        const map: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(execution.extensions as Record<string, unknown>)) {
            if (typeof v === 'boolean') map[k] = v;
        }
        if (Object.keys(map).length > 0) extensions = map;
    }
    // Tri-state: only an explicit boolean is meaningful. Anything else (absent,
    // null, a string) reads as "not declared" so an older Specialists release
    // stays launchable. xtrm-6hey0.3.
    const interactive = typeof execution?.interactive === 'boolean' ? execution.interactive : undefined;
    return { name, systemPrompt, skillPaths, model, thinkingLevel, extensions, interactive };
}

function isUnsupportedSurfaceOption(stderr: string): boolean {
    return /unknown (?:option|flag)|unrecognized option|unexpected argument|invalid option/i.test(stderr);
}

export function resolveRole(
    name: string,
    mainRepoRoot: string = process.cwd(),
    runtime: 'pi' | 'claude' = 'pi',
    allowLegacyFallback = false,
): ResolvedRole {
    // SEC-01: sp resolves repo-local .specialists specs from its cwd — pin it
    // to the main checkout root so a subdirectory launch still sees them.
    let result = spawnSync('sp', ['view', name, '--raw', '--surface', runtime], {
        cwd: mainRepoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
    });
    const stderr = (result.stderr ?? '').trim();

    // Older Specialists releases predate surface-aware model resolution. Pi
    // can safely retain its historical merged-default behavior. Claude may do
    // so only when an explicit CLI model makes the role default irrelevant;
    // normal launches must fail rather than reintroduce provider leakage.
    if (result.status !== 0
        && (runtime === 'pi' || allowLegacyFallback)
        && isUnsupportedSurfaceOption(stderr)) {
        // Legacy sp: same main-root cwd so repo-local specs resolve from a
        // subdirectory launch (reviewer 751b MED).
        result = spawnSync('sp', ['view', name, '--raw'], {
            cwd: mainRepoRoot,
            encoding: 'utf8',
            stdio: 'pipe',
        });
    }
    if (result.status !== 0) {
        const error = (result.stderr ?? '').trim() || 'unknown error';
        if (runtime === 'claude' && isUnsupportedSurfaceOption(error)) {
            throw new Error(
                `role '${name}': Specialists does not support surface-aware Claude model resolution; `
                + `upgrade @jaggerxtrm/specialists before launching xt claude --role`,
            );
        }
        throw new Error(`role '${name}' not found via sp view (${error})`);
    }
    return parseSpecialistJson(name, result.stdout ?? '', mainRepoRoot);
}

export interface RenderedRoleTask {
    initialPrompt: string;
    promptHash: string;
    components: Array<{ kind: string; name: string; tokens: number; bytes: number }>;
}

export function renderRoleTask(args: {
    role: string;
    bead: string;
    cwd: string;
    runtime: 'pi' | 'claude';
}): RenderedRoleTask {
    const result = spawnSync('sp', [
        'render-task', args.role,
        '--bead', args.bead,
        '--cwd', args.cwd,
        '--context-depth', '3',
        '--surface', args.runtime,
    ], {
        cwd: args.cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 16 * 1024 * 1024,
    });

    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout ?? '');
    } catch {
        throw new Error(`role '${args.role}': specialists render-task returned invalid JSON`);
    }
    const output = parsed as {
        ok?: unknown;
        initial_prompt?: unknown;
        prompt_hash?: unknown;
        components?: unknown;
        error?: { code?: unknown; message?: unknown };
    };
    if (result.status !== 0 || output.ok !== true) {
        const code = typeof output.error?.code === 'string' ? output.error.code : 'render_failed';
        const message = typeof output.error?.message === 'string' ? output.error.message : 'unknown error';
        throw new Error(`role '${args.role}': ${code}: ${message}`);
    }
    if (typeof output.initial_prompt !== 'string' || typeof output.prompt_hash !== 'string') {
        throw new Error(`role '${args.role}': specialists render-task returned an invalid success payload`);
    }
    const components = Array.isArray(output.components)
        ? output.components.filter((component): component is RenderedRoleTask['components'][number] => {
            if (!component || typeof component !== 'object') return false;
            const value = component as Record<string, unknown>;
            return typeof value.kind === 'string'
                && typeof value.name === 'string'
                && typeof value.tokens === 'number'
                && typeof value.bytes === 'number';
        })
        : [];
    return { initialPrompt: output.initial_prompt, promptHash: output.prompt_hash, components };
}

function slugifyForSession(input: string): string {
    const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s.slice(0, 32) || 'x';
}

function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function resolveRuntimeExecutable(runtime: 'pi' | 'claude'): string | null {
    const result = spawnSync('sh', ['-c', 'command -v "$1"', 'xtrm', runtime], {
        encoding: 'utf8',
        stdio: 'pipe',
    });
    const executable = (result.stdout ?? '').trim();
    return result.status === 0 && executable
        ? path.resolve(process.cwd(), executable)
        : null;
}

export function createRuntimeBufferName(): string {
    return `xtrm-role-${randomBytes(16).toString('hex')}`;
}

function deleteRuntimeBuffer(bufferName: string): void {
    spawnSync('tmux', ['delete-buffer', '-b', bufferName], { stdio: 'ignore' });
}

export function buildBufferedRuntimeCommand(
    bufferName: string,
    payloadWaitTimeoutMs: number = TMUX_PAYLOAD_READY_TIMEOUT_MS,
): string {
    const script = [
        "const { execFileSync, spawnSync } = require('node:child_process')",
        "const path = require('node:path')",
        'const buffer = process.argv[1]',
        "const cleanup = () => spawnSync('tmux', ['delete-buffer', '-b', buffer], { stdio: 'ignore' })",
        "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { cleanup(); process.exit(1) })",
        'let raw',
        'try {',
        "  execFileSync('tmux', ['wait-for', '-S', `${buffer}-consumer-ready`])",
        `  execFileSync('tmux', ['wait-for', \`\${buffer}-ready\`], { timeout: ${payloadWaitTimeoutMs}, killSignal: 'SIGTERM', stdio: 'ignore' })`,
        "  raw = execFileSync('tmux', ['show-buffer', '-b', buffer], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })",
        '} finally {',
        '  cleanup()',
        '}',
        'const payload = JSON.parse(raw)',
        "if (typeof payload.runtimeCmd !== 'string' || !['pi', 'claude'].includes(path.basename(payload.runtimeCmd)) || (!['pi', 'claude'].includes(payload.runtimeCmd) && !path.isAbsolute(payload.runtimeCmd)) || !Array.isArray(payload.runtimeArgs) || payload.runtimeArgs.some((arg) => typeof arg !== 'string')) process.exit(2)",
        "const result = spawnSync(payload.runtimeCmd, payload.runtimeArgs, { stdio: 'inherit' })",
        'if (result.error) throw result.error',
        'process.exit(result.status ?? 1)',
    ].join(';');
    return [process.execPath, '-e', script, bufferName].map(shellQuote).join(' ');
}

/**
 * Probe `sp render-skill-prefix --help` once at launcher startup. Newer sp
 * versions provide the canonical prefix directly; older versions fall back
 * to the merged role's declared skill paths. xtrm-8zsi1.
 */
export function probeSkillPrefixAvailable(): { ok: true } | { ok: false; error: string } {
    const r = spawnSync('sp', ['render-skill-prefix', '--help'], {
        stdio: 'pipe',
        encoding: 'utf8',
    });
    if (r.status === 0) return { ok: true };
    const stderr = (r.stderr ?? '').toString();
    return {
        ok: false,
        error: `sp render-skill-prefix not available (needed for trusted role launch prefixes).\n`
            + `Upgrade specialists: npm i -g @jaggerxtrm/specialists@latest\n`
            + `Original error: ${stderr.trim() || 'unknown'}`,
    };
}

export interface RenderSkillPrefixResult {
    /** May be the empty string when the specialist declares no skills. */
    skillPrefix: string;
}

/**
 * Call `sp render-skill-prefix <name> --surface pi|claude` and return the
 * skill_prefix string. Empty string is a legitimate result (no declared
 * skills). Throws with a specific error message when sp errors out with a
 * structured `{ok:false, error:{code,message}}` payload. xtrm-8zsi1.
 */
export function renderSkillPrefix(args: {
    role: string;
    runtime: 'pi' | 'claude';
    cwd?: string;
}): RenderSkillPrefixResult {
    const r = spawnSync(
        'sp',
        ['render-skill-prefix', args.role, '--surface', args.runtime],
        {
            cwd: args.cwd ?? process.cwd(),
            stdio: 'pipe',
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
        },
    );

    let parsed: unknown;
    try {
        parsed = JSON.parse(r.stdout ?? '');
    } catch {
        throw new Error(`role '${args.role}': sp render-skill-prefix returned invalid JSON`);
    }
    const output = parsed as {
        ok?: unknown;
        skill_prefix?: unknown;
        error?: { code?: unknown; message?: unknown };
    };
    if (r.status !== 0 || output.ok !== true) {
        const code = typeof output.error?.code === 'string' ? output.error.code : 'render_failed';
        const message = typeof output.error?.message === 'string' ? output.error.message : 'unknown error';
        throw new Error(`role '${args.role}': ${code}: ${message}`);
    }
    if (typeof output.skill_prefix !== 'string') {
        throw new Error(`role '${args.role}': sp render-skill-prefix returned no skill_prefix string`);
    }
    return { skillPrefix: output.skill_prefix };
}

/**
 * Position-0 '/' safety check on the composed turn-1 body. A '/' at literal
 * byte 0 is only safe when it's the sp-owned /skill:name (pi) or /<name>
 * (claude) prefix. Otherwise the runtime's slash-command parser would try to
 * interpret an operator-provided prompt or a bead title starting with '/' as
 * a command. xtrm-8zsi1.
 */
export function checkPositionZeroSlash(
    body: string,
    runtime: 'pi' | 'claude',
    trustedPrefix: string,
): { ok: true } | { ok: false; error: string } {
    const expectedPrefix = runtime === 'pi' ? '/skill:' : '/<name>';
    if (trustedPrefix) {
        const hasValidPrefix = runtime === 'pi'
            ? trustedPrefix.startsWith('/skill:')
            : /^\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\n\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*\n\n$/.test(trustedPrefix);
        if (!hasValidPrefix) {
            return { ok: false, error: `trusted skill prefix does not match the ${runtime} '${expectedPrefix}' surface.` };
        }
        return body.startsWith(trustedPrefix)
            ? { ok: true }
            : { ok: false, error: 'turn-1 body does not start with the exact trusted sp skill prefix.' };
    }
    if (body.length === 0 || body[0] !== '/') return { ok: true };
    return {
        ok: false,
        error: `turn-1 body starts with '/' but sp declared no '${expectedPrefix}' prefix: the runtime would parse untrusted text as a slash-command.\n`
            + `Rename the bead title or adjust --prompt so the first character is not '/'.`,
    };
}

/**
 * Derive the skill name from an absolute path produced by
 * `resolveRequestedSkills`. That resolver returns either the directory
 * `.../skill-name` or the SKILL.md file `.../skill-name/SKILL.md` depending
 * on which form matched, so normalize both. Used to render `/<name>`
 * force-load lines for claude explicit --skill delivery (xtrm-8zsi1
 * follow-up: --plugin-dir scaffold is gone, this is the replacement).
 */
export function claudeExplicitSkillLines(paths: string[], mainRepoRoot: string = process.cwd()): string {
    return paths
        .map((p) => {
            // Canonical runtime identity for pack-shaped paths (frontmatter
            // name), basename for everything else (SEC-NEW-02: never link the
            // directory name of a renamed pack skill).
            const name = resolveProjectPackEntry(mainRepoRoot, p)?.runtimeName
                ?? (path.basename(p) === 'SKILL.md' ? path.basename(path.dirname(p)) : path.basename(p));
            return `/${name}`;
        })
        .join('\n');
}

/**
 * Explicit-prefix rendering with structured claude entries: pack paths bind
 * their entry '/<name>' (requested name for name-resolved slots), while
 * non-pack paths keep basename identity — so a prefix line can never reintro-
 * duce basename identity for a renamed pack skill.
 */
export function claudeExplicitLinesFor(
    mainRepoRoot: string,
    paths: string[],
    entries: ClaudePackSkillEntry[],
): string {
    const byPath = new Map(entries.map((entry) => [entry.canonicalPath, entry.name]));
    return paths
        .map((p) => {
            let key: string;
            try { key = realpathSync(p); } catch { key = p; }
            const name = byPath.get(key)
                ?? (path.basename(p) === 'SKILL.md' ? path.basename(path.dirname(p)) : path.basename(p));
            return `/${name}`;
        })
        .join('\n');
}

export function renderDeclaredSkillPrefix(
    paths: string[],
    runtime: 'pi' | 'claude',
    mainRepoRoot: string = process.cwd(),
    entries?: ClaudePackSkillEntry[],
): string {
    const byPath = new Map((entries ?? []).map((entry) => [entry.canonicalPath, entry.name]));
    const names = [...new Set(paths.map((p) => {
        // Pack paths bind the structured entry name (requested alias for
        // name-resolved slots) so the fallback prefix always agrees with the
        // worktree link; without entries, fall back to canonical runtimeName.
        const bound = byPath.get(realpathSyncSafe(p));
        if (bound) return bound;
        const packName = resolveProjectPackEntry(mainRepoRoot, p)?.runtimeName;
        if (packName) return packName;
        return path.basename(p) === 'SKILL.md'
            ? path.basename(path.dirname(p))
            : path.basename(p);
    }))];
    for (const name of names) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
            throw new Error(`invalid declared skill name '${name}'`);
        }
    }
    if (names.length === 0) return '';
    const commands = names.map((name) => runtime === 'pi' ? `/skill:${name}` : `/${name}`);
    return `${commands.join(runtime === 'pi' ? ' ' : '\n')}\n\n`;
}

function realpathSyncSafe(p: string): string {
    try { return realpathSync(p); } catch { return p; }
}

export function checkByteCeiling(parts: {
    systemPrompt: string;
    body: string;
    source: 'prompt' | 'bead';
}): { ok: true } | { ok: false; error: string } {
    if (parts.systemPrompt.includes('\0') || parts.body.includes('\0')) {
        return { ok: false, error: 'turn-1 payload contains a NUL byte and cannot be passed to the runtime.' };
    }

    const systemBytes = Buffer.byteLength(parts.systemPrompt, 'utf8');
    const bodyBytes = Buffer.byteLength(parts.body, 'utf8');
    const total = systemBytes + bodyBytes;
    if (parts.source === 'prompt' && total > LITERAL_TURN1_BYTE_CEILING) {
        return {
            ok: false,
            error: `literal turn-1 payload is ${total} bytes (systemPrompt + body); ceiling is ${LITERAL_TURN1_BYTE_CEILING}.\n`
                + 'Move large task context into a --bead or trim the literal prompt.',
        };
    }
    if (systemBytes > RUNTIME_ARG_BYTE_CEILING || bodyBytes > RUNTIME_ARG_BYTE_CEILING) {
        return {
            ok: false,
            error: `turn-1 runtime argument ceiling is ${RUNTIME_ARG_BYTE_CEILING} bytes; `
                + `systemPrompt=${systemBytes}, body=${bodyBytes}.`,
        };
    }
    return { ok: true };
}

export interface TmuxLaunchPlan {
    sessionName: string;
    /** Runtime binary — 'pi' or 'claude'. */
    runtimeCmd: 'pi' | 'claude';
    /** Argv passed to the runtime binary (excluding the binary itself). */
    runtimeArgs: string[];
    /** Shell-quoted command line for `tmux new-session ...` (includes the binary). */
    runtimeCmdString: string;
    paneOptions: Array<{ key: string; value: string }>;
}

// Pure — no I/O. Exported for unit testing.
export function chooseAttachCommand(sessionName: string, insideTmux: boolean): string[] {
    return insideTmux
        ? ['switch-client', '-t', sessionName]
        : ['attach-session', '-t', sessionName];
}

/** Options shared verbatim by the role and bare plan builders. */
interface CommonTmuxPlanArgs {
    /** Which runtime binary this plan targets. */
    runtime: 'pi' | 'claude';
    /** Session display name passed to the runtime via --name (worktree slug). */
    sessionDisplayName: string;
    bead?: string;
    parentSessionId: string;
    /** Absolute path of the worktree this session owns. Required, not optional:
     * "every interactive xt runtime owns a distinct worktree and branch" is an
     * invariant (audit P1-02), and a plan that could omit it would let one of
     * the two launch paths silently stop publishing lineage. */
    worktreePath: string;
    /** Branch checked out in `worktreePath` — the integration branch for any
     * specialist chain this session dispatches (audit P1-03). */
    branchName: string;
    /** Turn-1 positional body — runtime-specific trusted skill prefix + user
     * body already concatenated. Empty string means no positional (skills-only prime). */
    turn1Body: string;
    /** CLI --model override; in role mode it wins over role.model. */
    modelOverride?: string;
    /** CLI --thinking override; in role mode it wins over role.thinkingLevel.
     * Silently dropped for claude (no --thinking flag) — caller warns at CLI
     * level if the user explicitly passed --thinking to xt claude. */
    thinkingOverride?: string;
    /** Explicit --skill requests, already resolved to absolute paths.
     * Emitted verbatim to pi's native --skill flag. Claude has no --skill
     * equivalent; preflight verifies the exact path is discoverable, then the
     * launcher prepends a `/<name>` force-load line to turn 1. */
    explicitSkillPaths?: string[];
    /** Argv after `--` on the xt command line, already guard-checked. */
    passthrough?: string[];
}

/** Emit `--skill <path>` per unique skill, deduped by realpath. pi-only. */
function pushSkillArgs(runtimeArgs: string[], skillPaths: string[]): void {
    const seen = new Set<string>();
    for (const skill of skillPaths) {
        const identity = existsSync(skill) ? realpathSync(skill) : skill;
        if (seen.has(identity)) continue;
        seen.add(identity);
        runtimeArgs.push('--skill', skill);
    }
}

/**
 * Channel entry id for the specialists Claude plugin (plugin name, then
 * marketplace). XTRM-249. The plugin declares Claude Code's experimental
 * `claude/channel` capability; with this entry passed to `claude --channels`,
 * a settling specialist pushes `notifications/claude/channel` straight into
 * the session instead of leaving it on the asyncRewake polling path.
 */
export const SPECIALISTS_CHANNEL_ENTRY = 'plugin:specialists@xtrm';

/**
 * True when the specialists plugin is installed for this user.
 *
 * Fail-soft by construction: a missing file, unreadable file, malformed JSON,
 * or absent entry all return false and the launcher simply omits --channels.
 * Claude Code gates channels on several client-side conditions (managed
 * `channelsEnabled` / `allowedChannelPlugins` among them) and every one of them
 * fails silently, so an unusable entry must never be fatal here — the flag is
 * an accelerator for the wake path, not a launch requirement.
 *
 * Operators additionally need managed settings — see docs/xt-claude-channels.md.
 */
export function specialistsPluginInstalled(
    homeDir: string = os.homedir(),
): boolean {
    try {
        const manifest = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return false;
        const plugins = (parsed as { plugins?: unknown }).plugins;
        if (typeof plugins !== 'object' || plugins === null) return false;
        const entry = (plugins as Record<string, unknown>)['specialists@xtrm'];
        return Array.isArray(entry) && entry.length > 0;
    } catch {
        return false;
    }
}

/**
 * Shared tail of both plan builders. Everything from `--model` onward is
 * identical between a role launch and a bare one — only the head (system
 * prompt, skill pool policy, session name, @agent_task) differs, which is
 * exactly what the two builders own. xtrm-3xgs5.
 */
function finalizeTmuxPlan(args: {
    runtime: 'pi' | 'claude';
    sessionName: string;
    /** Head args, mutated in place with the shared tail. */
    runtimeArgs: string[];
    sessionDisplayName: string;
    agentTask: string;
    bead?: string;
    /** Role name in role mode; absent in bare mode (a bare session has no role). */
    role?: string;
    parentSessionId: string;
    worktreePath: string;
    branchName: string;
    turn1Body: string;
    model?: string;
    thinking?: string;
    passthrough?: string[];
}): TmuxLaunchPlan {
    const {
        runtime, sessionName, runtimeArgs, sessionDisplayName, agentTask, bead, role,
        parentSessionId, worktreePath, branchName, turn1Body, model, thinking, passthrough,
    } = args;

    // Launcher-owned session display name. Pushed first so nothing later in the
    // shared tail (or the runtime's own argv handling) can shadow it; the
    // passthrough guard already rejects user-supplied --name as xt-owned.
    // xtrm-rhmm1.
    runtimeArgs.unshift('--name', sessionDisplayName);

    // Model: both runtimes accept --model <name>; pi and claude resolve their
    // own defaults when unset.
    if (model) runtimeArgs.push('--model', model);

    // Channel wake: claude-only, and only when the specialists plugin is
    // actually installed. Omitting the flag is always safe (the session falls
    // back to the asyncRewake polling hook), so every negative answer here —
    // no plugin, no manifest, unreadable manifest — just means "no flag".
    // Never use --dangerously-load-development-channels: it prints an
    // interactive confirmation dialog on every launch, which would block
    // automated dispatch. XTRM-249.
    if (runtime === 'claude' && specialistsPluginInstalled()) {
        runtimeArgs.push('--channels', SPECIALISTS_CHANNEL_ENTRY);
    }

    // Thinking: pi-only. Claude has no --thinking flag; silently drop when
    // the target is claude (caller warns at CLI-level if user was explicit).
    if (runtime === 'pi' && thinking) runtimeArgs.push('--thinking', thinking);

    // Passthrough: append verbatim (caller must have run guardRolePassthrough
    // first to reject xt-owned flags and drop batch-mode incompatibles).
    if (passthrough && passthrough.length > 0) {
        runtimeArgs.push(...passthrough);
    }

    // Turn-1 body: trusted skill prefix + operator/bead body, already
    // concatenated by the caller. Claude needs `--` to protect the positional
    // from variadic options (--model etc. can consume it otherwise); pi's
    // positional prompt convention is delimiter-free. Empty body means "no
    // positional" (skills-only prime — pane idles at first turn).
    if (turn1Body.length > 0) {
        if (runtime === 'claude') runtimeArgs.push('--');
        runtimeArgs.push(turn1Body);
    }

    const runtimeCmdString = [runtime, ...runtimeArgs].map(shellQuote).join(' ');

    // Pane metadata written on the target pane at launch time. Picker + safe-
    // send-pointer + handoff read these. @agent_state=idle so the picker sees
    // the pane immediately (the runtime's own agent-state hook won't fire
    // until the first turn). @agent_prompt_file dropped in xtrm-8zsi1 — the
    // launcher no longer materializes a prompt file (turn-1 is inline), and
    // downstream skills read the option absence-safely (|| true).
    //
    // @agent_worktree / @agent_branch make the P1-02 invariant *observable*
    // rather than merely true: the isolation was always enforced by
    // construction in launchWorktreeSession, but nothing downstream could see
    // which worktree or branch a pane owned. @agent_branch is also how a
    // coordinator tells its specialist chains which integration branch to
    // derive from (audit P1-03) — Core publishes it, Specialists consumes it.
    // @agent_role is the role identity that @agent_task only encoded as a
    // `role:` prefix; a plain key is what a nested-coordinator check can read.
    const paneOptions: Array<{ key: string; value: string }> = [
        { key: '@agent_parent_session', value: parentSessionId },
        { key: '@agent_task', value: agentTask },
        { key: '@agent_state', value: 'idle' },
        { key: '@agent_worktree', value: worktreePath },
        { key: '@agent_branch', value: branchName },
    ];
    if (bead) paneOptions.push({ key: '@agent_bead', value: bead });
    if (role) paneOptions.push({ key: '@agent_role', value: role });

    return { sessionName, runtimeCmd: runtime, runtimeArgs, runtimeCmdString, paneOptions };
}

export function buildRoleTmuxPlan(args: CommonTmuxPlanArgs & {
    role: ResolvedRole;
}): TmuxLaunchPlan {
    const {
        runtime, sessionDisplayName, role, bead, parentSessionId, worktreePath, branchName,
        turn1Body, modelOverride, thinkingOverride, explicitSkillPaths = [], passthrough,
    } = args;

    // Include runtime in the session name so xt pi --role X --bead Y and
    // xt claude --role X --bead Y produce distinguishable sessions
    // (role-pi-X-Y vs role-claude-X-Y) instead of colliding on role-X-Y and
    // relying on xtmux-1lb.6's auto-suffix. Operator's mental model is one
    // pi + one claude flavor of the same specialist, not "the second one
    // gets a random hex". See xtmux-3h8.
    const roleSlug = slugifyForSession(role.name);
    const sessionName = bead
        ? `role-${runtime}-${roleSlug}-${slugifyForSession(bead)}`
        : `role-${runtime}-${roleSlug}`;

    // Inline system prompt on both runtimes (xtrm-8zsi1). The xtrm-osipt
    // stopgap's --file variants were needed only when injectSkillContents
    // (xtrm-14w28) fattened the prompt to ~70KB; sp render-skill-prefix now
    // forces skill body load via /skill:name at turn-1 so the identity
    // system prompt stays small enough to inline safely under the byte
    // guard.
    const runtimeArgs: string[] = ['--append-system-prompt', role.systemPrompt];

    if (runtime === 'pi') {
        // Role pool isolation: --no-skills disables pi's global skill-pool
        // auto-discovery. Combined with explicit --skill <path> per declared
        // + operator-requested skill, only the declared set is
        // reachable. Matches sp's forthcoming unitAI-0o3pv behavior; core
        // ships this now regardless of sp release timing (self-diagnosing
        // "skill not found" is a fine loud-fail surface). xtrm-8zsi1.
        runtimeArgs.push('--no-skills');
        pushSkillArgs(runtimeArgs, [...role.skillPaths, ...explicitSkillPaths]);
        // Extensions: trust pi's own discovery (~/.pi/agent/settings.json plus
        // any per-repo settings). Previously (PR #365) the launcher emitted
        // `--no-extensions -e <name>...` from a curated allow-list, but `pi -e`
        // takes a **filesystem path**, not a registry name — the launcher was
        // silently crashing pi on startup. Drop the policy; trust discovery.
        // See xtmux-3rs.
    } else {
        // Claude: no --no-skills equivalent exists (--bare is nuclear and
        // disables hooks/CLAUDE.md/OAuth). Accept partial isolation — global
        // ~/.claude/skills auto-discovery remains. Declared skills force-load
        // via sp-owned /<name> lines in the turn-1 body prefix; operator
        // --skill additions (explicitSkillPaths) are prepended as
        // /<name> in launchWorktreeSession composition before turn1Body
        // reaches this function. No --plugin-dir scaffold anymore.
        runtimeArgs.push('--dangerously-skip-permissions');
    }

    // CLI override wins over the specialist default. On claude a cross-provider
    // role default is unusable, so drop it and let claude inherit the parent
    // runtime model instead of spawning a session that dies at turn 1.
    let model = modelOverride ?? role.model;
    if (runtime === 'claude' && !modelOverride && role.model && isForeignProviderModel(role.model)) {
        process.stderr.write(kleur.yellow(
            `  ⚠ role '${role.name}': ignoring non-Claude model '${role.model}'; claude inherits the parent model.`
            + ` Declare execution.surface_models.claude on the specialist (or pass --model) to pin one.\n`,
        ));
        model = undefined;
    }

    return finalizeTmuxPlan({
        runtime,
        sessionDisplayName,
        sessionName,
        runtimeArgs,
        agentTask: `role:${role.name}`,
        bead,
        role: role.name,
        parentSessionId,
        worktreePath,
        branchName,
        turn1Body,
        model,
        thinking: thinkingOverride ?? role.thinkingLevel,
        passthrough,
    });
}

/**
 * Plan for a launch with no specialist behind it: `xt claude <name>
 * --prompt ...`. No system prompt, no skill-pool isolation policy, and no
 * bead in the session name — a bare session is identified by its worktree
 * slug alone (`<runtime>-<slug>`), with any --bead carried as pane/env
 * metadata only. xtrm-3xgs5 (was a nullable `role?` through the role
 * builder, PR #433).
 */
export function buildBareTmuxPlan(args: CommonTmuxPlanArgs & {
    /** Worktree/session slug — the sole identity of a bare session. */
    sessionSlug: string;
}): TmuxLaunchPlan {
    const {
        runtime, sessionDisplayName, sessionSlug, bead, parentSessionId, worktreePath,
        branchName, turn1Body, modelOverride, thinkingOverride, explicitSkillPaths = [], passthrough,
    } = args;

    const runtimeArgs: string[] = [];
    if (runtime === 'pi') {
        // No --no-skills: a bare session has no declared skill set to isolate
        // to, so pi's global pool discovery stays on and explicit --skill
        // requests are additive.
        pushSkillArgs(runtimeArgs, explicitSkillPaths);
    } else {
        runtimeArgs.push('--dangerously-skip-permissions');
    }

    return finalizeTmuxPlan({
        runtime,
        sessionDisplayName,
        sessionName: `${runtime}-${slugifyForSession(sessionSlug)}`,
        runtimeArgs,
        agentTask: `session:${sessionSlug}`,
        bead,
        parentSessionId,
        worktreePath,
        branchName,
        turn1Body,
        model: modelOverride,
        thinking: thinkingOverride,
        passthrough,
    });
}

/**
 * Environment variables exported to the pi/claude child process so scripts/
 * agent-state.sh (and the picker's own reads) can find the metadata without
 * an extra tmux query. Redundant with paneOptions on purpose — the launcher
 * writes options once at spawn (state=idle etc.), and env vars survive re-
 * execs the way pane options do not. xtmux-1lb.5.1.
 *
 * Derived from the plan's pane options rather than rebuilt from the same
 * inputs: the two carry identical lineage, and the previous hand-rolled pair
 * (one builder for role, an inline object literal for bare) is exactly the
 * shape that drifts when a field is added — as adding @agent_worktree /
 * @agent_branch / @agent_role would have. `@agent_state` is launcher-local
 * bookkeeping owned by the runtime's own hook after turn 1, so it is the one
 * option that does not become an env var.
 *
 * XTMUX_AGENT_PROMPT_FILE dropped in xtrm-8zsi1 — turn 1 has no file path,
 * and downstream consumers read the variable absence-safely.
 */
export function buildAgentEnv(
    paneOptions: ReadonlyArray<{ key: string; value: string }>,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const { key, value } of paneOptions) {
        if (key === '@agent_state') continue;
        env[`XTMUX_AGENT_${key.slice('@agent_'.length).toUpperCase()}`] = value;
    }
    return env;
}

function currentTmuxSessionId(): string {
    if (!process.env.TMUX) return '';
    const r = spawnSync('tmux', ['display-message', '-p', '-F', '#{session_id}'], {
        encoding: 'utf8',
        stdio: 'pipe',
    });
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

function randomSlug(len: number = 4): string {
    return Math.random().toString(36).slice(2, 2 + len);
}

function gitRepoRoot(cwd: string): string | null {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd, stdio: 'pipe', encoding: 'utf8',
    });
    return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

function gitMainRepoRoot(cwd: string): string | null {
    const common = spawnSync('git', ['rev-parse', '--git-common-dir'], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
    });

    if (common.status !== 0) return null;

    const raw = (common.stdout ?? '').trim();
    if (!raw) return null;
    const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    return commonDir.endsWith('/.git') || commonDir.endsWith('\\.git')
        ? path.dirname(commonDir)
        : commonDir;
}

/**
 * Transactional rollback of a launcher-created worktree and — only when THIS
 * invocation created the branch (SEC-FINAL-01) — its branch. `git worktree
 * remove --force` removes the working tree but leaves the `xt/<slug>` branch;
 * a pre-existing reused branch/ref/commit must survive provisioning failure,
 * so `git branch -D` runs only for launcher-created branches. When the
 * worktree removal itself fails, report that the branch may remain. Exported
 * for unit testing.
 */
export function rollbackLauncherWorktree(mainRepoRoot: string, worktreePath: string, branchName: string, deleteBranch: boolean): void {
    const removal = spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: mainRepoRoot,
        stdio: 'pipe',
    });
    if (removal.status !== 0) {
        process.stderr.write(kleur.yellow(
            `  ⚠ provisioning failed and worktree removal did not succeed; branch '${branchName}' may remain. `
            + `Run 'xt worktree doctor'; manually 'git branch -D ${branchName}'\n`,
        ));
        return;
    }
    if (!deleteBranch) return;
    const branchRemoval = spawnSync('git', ['branch', '-D', branchName], {
        cwd: mainRepoRoot,
        stdio: 'pipe',
    });
    if (branchRemoval.status !== 0) {
        process.stderr.write(kleur.yellow(
            `  ⚠ worktree removed but branch '${branchName}' could not be deleted; run 'git branch -D ${branchName}'\n`,
        ));
    }
}

function ensureWorktreeSpecialists(worktreePath: string, mainRepoPath: string): void {
    const worktreeSpecialistsRoot = path.join(worktreePath, '.specialists');
    mkdirSync(worktreeSpecialistsRoot, { recursive: true });

    const specialistDirs = ['default', 'user'] as const;
    for (const dirName of specialistDirs) {
        const sourceDir = path.join(mainRepoPath, '.specialists', dirName);
        if (!existsSync(sourceDir)) continue;

        const targetDir = path.join(worktreeSpecialistsRoot, dirName);
        const symlinkTarget = path.relative(path.dirname(targetDir), sourceDir);

        try {
            const existing = lstatSync(targetDir);
            if (existing.isSymbolicLink() && readlinkSync(targetDir) === symlinkTarget) {
                continue;
            }
            rmSync(targetDir, { recursive: true, force: true });
        } catch {
            // target does not exist
        }

        symlinkSync(symlinkTarget, targetDir, 'dir');
    }

    // Mask the dir->symlink swap from git: skip-worktree on tracked
    // .specialists/{default,user}/* paths so checkpoint commits don't capture
    // phantom deletions or stage the symlink itself with mode 120000.
    // Same merge-hazard pattern fixed for .beads in xtrm-cbjo — without this
    // a chain-branch squash-merge would wipe the parent's .specialists/user/
    // (see infra repo PR #39 for the equivalent .beads incident). xtrm-6jd2.
    markPathSkipWorktree(worktreePath, '.specialists/default');
    markPathSkipWorktree(worktreePath, '.specialists/user');
}

/**
 * Normalize the parent repo's `core.hooksPath` to an absolute path if it is
 * currently a relative `.beads/hooks` reference. Older bd installs stored a
 * relative path which would resolve against the worktree's cwd in a worktree
 * — i.e., against the (now-missing) worktree-local `.beads/hooks/`. The fix
 * is idempotent: only rewrites the exact relative `.beads/hooks` form, never
 * touches absolute paths, project-style `.githooks` chains, or unset values.
 *
 * No-op for the vast majority of repos surveyed 2026-05-12 — but cheap
 * insurance so a fresh-install on an older bd binary cannot resurface the
 * "hooks fire from missing path" failure mode after xtrm-cbjo lands.
 */
function normalizeParentHooksPath(mainRepoRoot: string): void {
    try {
        const result = spawnSync('git', ['-C', mainRepoRoot, 'config', '--get', 'core.hooksPath'], {
            stdio: 'pipe',
            encoding: 'utf8',
        });
        if (result.status !== 0) return;
        const current = (result.stdout ?? '').trim();
        if (!current) return;
        if (path.isAbsolute(current)) return;
        // Only rewrite the canonical bd default. Leave `.githooks` chains and
        // other project conventions alone — those are intentional.
        if (current !== '.beads/hooks' && current !== './.beads/hooks') return;
        const absolute = path.join(mainRepoRoot, '.beads', 'hooks');
        spawnSync('git', ['-C', mainRepoRoot, 'config', 'core.hooksPath', absolute], { stdio: 'pipe' });
    } catch {
        // non-fatal
    }
}

/**
 * Mark all tracked files under `<worktree>/<pathspec>` as skip-worktree so
 * that index/worktree differences for those paths do not surface in
 * `git status` or checkpoint diffs.
 *
 * Used for runtime-only directories that are either rm'd (`.beads`) or
 * dir->symlink-swapped (`.specialists/{default,user}`) inside a worktree
 * but should never be committed back to the chain branch — preventing the
 * `.beads`-style squash-merge wipe hazard (real incident: projects/infra
 * PR #39 for `.beads`; same shape applies to `.specialists/user/*`).
 */
function markPathSkipWorktree(worktreePath: string, pathspec: string): void {
    try {
        const trackedResult = spawnSync('git', ['-C', worktreePath, 'ls-files', '--', pathspec], {
            cwd: worktreePath,
            stdio: 'pipe',
            encoding: 'utf8',
        });
        if (trackedResult.status !== 0) return;

        const trackedPaths = (trackedResult.stdout ?? '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (trackedPaths.length === 0) return;

        spawnSync('git', ['-C', worktreePath, 'update-index', '--skip-worktree', '--', ...trackedPaths], {
            cwd: worktreePath,
            stdio: 'pipe',
            encoding: 'utf8',
        });
    } catch {
        // non-fatal
    }
}

export interface SessionMeta {
    runtime: 'claude' | 'pi' | 'codex';
    launchedAt: string;
}

// Write to .xtrm/ (gitignored) to prevent the file from ever being committed.
function sessionMetaPath(worktreePath: string): string {
    return path.join(worktreePath, '.xtrm', 'session-meta.json');
}

export function writeSessionMeta(worktreePath: string, runtime: 'claude' | 'pi'): boolean {
    try {
        const meta: SessionMeta = { runtime, launchedAt: new Date().toISOString() };
        const dest = sessionMetaPath(worktreePath);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, JSON.stringify(meta, null, 2));
        return true;
    } catch {
        return false;
    }
}

export function readSessionMeta(worktreePath: string): SessionMeta | null {
    try {
        // Try new location first (.xtrm/session-meta.json), fall back to old root location.
        const newPath = sessionMetaPath(worktreePath);
        const oldPath = path.join(worktreePath, '.session-meta.json');
        const filePath = existsSync(newPath) ? newPath : oldPath;
        const raw = readFileSync(filePath, 'utf8');
        return JSON.parse(raw) as SessionMeta;
    } catch {
        return null;
    }
}

export function unregisterPluginsForWorktree(worktreePath: string): void {
    const localSettingsPath = path.join(worktreePath, '.claude', 'settings.local.json');

    try {
        if (existsSync(localSettingsPath)) {
            unlinkSync(localSettingsPath);
        }
    } catch {
        // non-fatal
    }
}

/**
 * Effective flags a `--subordinate` launch expands to.
 *
 * `--subordinate` is one verb for the canonical subordinate-coordinator launch
 * shape (audit P0-05). Inside $TMUX an interactive role launch otherwise
 * defaults to the *current* pane — correct when the operator wants this pane to
 * become the role, unsafe when spawning a subordinate, because it overwrites the
 * orchestrator's own @agent_* metadata and replaces the orchestrator process.
 * The safe shape was three flags the operator had to remember and compose:
 * `--new-session --no-attach --parent "$(tmux display-message -p '#{session_id}')"`.
 *
 * It expands to flags the launcher already understands rather than introducing a
 * third launch mode — deliberately, so there stays exactly one code path to
 * reason about. It does NOT imply "no worktree", "shared branch", or "direct
 * main integration": every interactive launch owns a distinct worktree and
 * branch regardless (audit P1-02), and that is enforced below by construction.
 */
export type SubordinateResolution =
    | { ok: true; newSession: true; attach: false; child: boolean }
    | { ok: false; error: string };

/**
 * Shape every subordinate rejection the same way: one line naming what was
 * wrong, then the canonical long-form command as remediation. Matches the error
 * the audit suggests in P1-05, parameterized by the runtime actually launching.
 */
export function subordinateRejection(runtime: 'pi' | 'claude', because: string): string {
    const canonical = [
        `  xt ${runtime} <name> \\`,
        '    --role chain-coordinator \\',
        '    --bead <id> \\',
        '    --new-session \\',
        '    --no-attach \\',
        '    --parent <session-id>',
    ].join('\n');
    return `subordinate launch rejected:\n  ${because}\n\nUse:\n${canonical}`;
}

// Pure — no I/O. Exported for unit testing.
export function resolveSubordinateLaunch(args: {
    runtime: 'pi' | 'claude';
    role?: string;
    bead?: string;
    parent?: string;
    insideTmux: boolean;
}): SubordinateResolution {
    const { runtime, role, bead, parent, insideTmux } = args;
    const reject = (because: string): SubordinateResolution => ({
        ok: false,
        error: subordinateRejection(runtime, because),
    });

    if (!role) {
        return reject('--subordinate is a coordinator launch and requires --role');
    }
    // Audit P1-05, "a bead is supplied". A coordinator's whole contract is "own
    // exactly one epic or task-group"; without a bead it has no scope to own and
    // nothing to report against. Only enforced for --subordinate — a plain
    // `--role` launch is an operator priming a pane and may legitimately idle.
    if (!bead) {
        return reject('--subordinate scopes a coordinator to one epic and requires --bead');
    }
    // A subordinate is defined by having a parent. Inside tmux the current
    // session supplies it; outside tmux there is nothing to infer from, so an
    // explicit --parent is the only way the relationship can exist at all.
    if (!insideTmux && !parent) {
        return reject('subordinate coordinator requires a parent session');
    }

    // `child` is the existing explicit opt-in for "parent = current session".
    // An explicit --parent is the operator being deliberate and still wins, so
    // only claim the auto-parent when they did not name one.
    return { ok: true, newSession: true, attach: false, child: !parent };
}

/**
 * The two P1-05 checks that need a resolved role and the launching pane's
 * identity, rather than just argv. Split from resolveSubordinateLaunch because
 * they run later — after `sp view` has answered — but still before any worktree
 * is created, so a rejected launch leaks nothing.
 *
 * Pure — no I/O. Exported for unit testing.
 */
export function checkSubordinateRole(args: {
    runtime: 'pi' | 'claude';
    role: ResolvedRole;
    /** @agent_role of the pane running the launcher, '' when absent. */
    launchingPaneRole: string;
}): { ok: true } | { ok: false; error: string } {
    const { runtime, role, launchingPaneRole } = args;

    // Tri-state: only an explicit `false` rejects. An older Specialists release
    // that does not declare `interactive` must stay launchable.
    if (role.interactive === false) {
        return {
            ok: false,
            error: subordinateRejection(
                runtime,
                `role '${role.name}' declares execution.interactive=false — it is a background job, not a session`,
            ),
        };
    }

    // "the role is not being launched by another chain coordinator". The
    // chain-coordinator system prompt already says "Don't spawn nested
    // chain-coordinators"; until @agent_role existed (xtrm-6hey0.2) that was
    // pure honour system. Compares the launching pane's role to the role being
    // launched, so it generalizes to any self-nesting coordinator rather than
    // hard-coding one specialist name.
    if (launchingPaneRole && launchingPaneRole === role.name) {
        return {
            ok: false,
            error: subordinateRejection(
                runtime,
                `nested coordinator: this pane is already running role '${launchingPaneRole}'`
                + ' — escalate to the main orchestrator instead of spawning a peer',
            ),
        };
    }

    return { ok: true };
}

/**
 * `@agent_role` of the pane the launcher was invoked from, or '' when there is
 * no tmux, no pane option, or tmux is unavailable. Absence is always benign:
 * these checks are launch guardrails, not a security boundary.
 */
function currentPaneRole(): string {
    if (!process.env.TMUX) return '';
    const r = spawnSync('tmux', ['display-message', '-p', '#{pane_id}'], {
        stdio: 'pipe', encoding: 'utf8',
    });
    const paneId = (r.stdout ?? '').trim();
    if (!paneId) return '';
    const option = spawnSync('tmux', ['show-options', '-p', '-t', paneId, '-qv', '@agent_role'], {
        stdio: 'pipe', encoding: 'utf8',
    });
    return (option.stdout ?? '').trim();
}

export async function launchWorktreeSession(opts: WorktreeSessionOptions): Promise<void> {
    const { runtime, name, role: roleName, bead, prompt, model, thinking } = opts;
    const cwd = process.cwd();

    // Runtime compatibility preflight (audit P1-06). First thing in the
    // launcher: reject an incompatible Core/Specialists/xtmux trio before any
    // worktree, branch or tmux session exists, and before `sp` — possibly the
    // incompatible half — is consulted at all. Repair commands (`xt update`,
    // `xt doctor`) are deliberately not gated, so a drifted install stays
    // fixable. Absence of a sibling is not an incompatibility; see
    // runtime-compat.ts.
    const compatError = runtimeCompatibilityError();
    if (compatError) {
        console.error(kleur.red(`\n  ✗ ${compatError}\n`));
        console.error(kleur.dim('  Refusing to create an interactive worktree against a runtime Core does not support.'));
        console.error(kleur.dim('\n  Remediation:'));
        console.error(kleur.dim('    1) upgrade the flagged package(s) to a version inside the range'));
        console.error(kleur.dim('    2) or upgrade xtrm-tools, if this Core predates them'));
        console.error(kleur.dim('    3) xt doctor — inspect the installed runtime'));
        console.error(kleur.dim('\n  Override (at your own risk): XTRM_SKIP_RUNTIME_COMPAT=1\n'));
        process.exit(1);
    }

    // Expand --subordinate before anything else so the rest of the launcher
    // only ever sees ordinary newSession/attach/parent flags.
    let { attach = true } = opts;
    let newSession = opts.newSession;
    let child = opts.child;
    if (opts.subordinate) {
        const subordinate = resolveSubordinateLaunch({
            runtime,
            role: roleName,
            bead,
            parent: opts.parent,
            insideTmux: Boolean(process.env.TMUX),
        });
        if (!subordinate.ok) {
            console.error(kleur.red(`\n  ✗ ${subordinate.error}\n`));
            process.exit(1);
        }
        newSession = subordinate.newSession;
        attach = subordinate.attach;
        child = subordinate.child;
    }

    const structuredOutput = Boolean(opts.json);
    const structuredCheck = checkStructuredLaunchOptions({
        json: structuredOutput,
        attach,
        reuse: Boolean(opts.reuse),
        sessionSlug: name,
        role: Boolean(roleName),
        insideTmux: Boolean(process.env.TMUX),
        newSession: Boolean(newSession),
    });
    if (!structuredCheck.ok) {
        console.error(kleur.red(`\n  ✗ ${structuredCheck.error}\n`));
        process.exit(1);
    }

    // Mutual exclusion: in role mode --bead renders a tracked task and
    // --prompt supplies a literal turn-1 body; the two contract different
    // composition paths and can't stack. Rejected at the launcher rather than
    // each CLI so both xt pi and xt claude enforce the same rule from one
    // place. Bare mode is exempt: `sp render-task` takes the specialist name
    // as a required positional, so there is no roleless render and --bead is
    // metadata only (pane option + env + picker preview). A tag and a body
    // don't conflict. xtrm-3xgs5.
    if (roleName && bead && prompt) {
        console.error(kleur.red('\n  ✗ --bead and --prompt are mutually exclusive; pick one\n'));
        process.exit(1);
    }

    // An explicit --model is the operator's word — only a pi-surface
    // `provider/model` pair is refused, because claude cannot run one and would
    // start into a session that never takes turn 1. Fail loudly here, before a
    // worktree exists. Role defaults are handled in buildRoleTmuxPlan (warn +
    // inherit the parent model). xtrm-wiy5n.4.19.
    const selectedModel = effectiveModel(model, opts.passthrough ?? []);
    const foreignModel = runtime === 'claude' && selectedModel && isForeignProviderModel(selectedModel)
        ? selectedModel
        : undefined;
    if (foreignModel) {
        console.error(kleur.red(`\n  ✗ --model '${foreignModel}' is a non-Anthropic provider model; claude would start and then die at turn 1\n`));
        console.error(kleur.dim('  Use a Claude id or alias: opus, sonnet, haiku, claude-opus-5, …\n'));
        process.exit(1);
    }

    // Guard passthrough before repository discovery or any worktree mutation.
    let guardedPassthrough: string[] = [];
    if (opts.passthrough && opts.passthrough.length > 0) {
        const guard = guardRolePassthrough(opts.passthrough);
        if (guard.guardedError) {
            console.error(kleur.red(`\n  ✗ ${guard.guardedError}\n`));
            process.exit(1);
        }
        for (const warning of guard.warnings) {
            process.stderr.write(kleur.yellow(`  ⚠ ${warning}\n`));
        }
        guardedPassthrough = guard.filteredArgs;
    }

    // SEC-01: git defines the resolution root. Compute the current checkout
    // root and the common/main repo root BEFORE any role/skill resolution and
    // refuse a nested-worktree launch up front, so a launch from repo/subdir
    // resolves against the main checkout root (never subdir/.xtrm) and can
    // never fall to a global skill while the root pack exists.
    const currentRepoRoot = gitRepoRoot(cwd);
    const mainRepoRoot = gitMainRepoRoot(cwd);
    if (!currentRepoRoot || !mainRepoRoot) {
        console.error(kleur.red('\n  ✗ Not inside a git repository\n'));
        process.exit(1);
    }
    if (currentRepoRoot !== mainRepoRoot) {
        console.error(kleur.red('\n  ✗ Refusing to create nested worktree from inside an existing worktree.\n'));
        console.error(kleur.dim(`  current worktree: ${currentRepoRoot}`));
        console.error(kleur.dim(`  main repo root:  ${mainRepoRoot}`));
        console.error(kleur.dim('\n  Remediation:'));
        console.error(kleur.dim('    1) cd to the main repo checkout'));
        console.error(kleur.dim('    2) run xt claude|pi there (or use xt attach to resume this session)'));
        console.error(kleur.dim('    3) run xt worktree doctor to inspect stale/nested entries\n'));
        process.exit(1);
    }

    // Resolve role up-front so we fail fast on an unknown role name before
    // creating a worktree (which would otherwise leak on a bad --role typo).
    // Probe sp render-skill-prefix before worktree creation so every launch
    // can bind byte-zero slash commands to trusted renderer output.
    let resolvedRole: ResolvedRole | null = null;
    let renderedTask: RenderedRoleTask | undefined;
    let composedTurn1Body: string = '';
    let explicitSkillPaths: string[] = [];
    // Structured claude pack entries (bound '/<name>' + canonical identity),
    // computed preflight and consumed by gates and worktree materialization.
    let claudePackEntries: ClaudePackSkillEntry[] = [];
    if (roleName) {
        try {
            resolvedRole = resolveRole(roleName, mainRepoRoot, runtime, Boolean(model));

            // The P1-05 checks that need the resolved role. Placed immediately
            // after `sp view` answers and long before worktree creation, so a
            // rejected coordinator launch leaves nothing on disk.
            if (opts.subordinate) {
                const coordinatorCheck = checkSubordinateRole({
                    runtime,
                    role: resolvedRole,
                    launchingPaneRole: currentPaneRole(),
                });
                if (!coordinatorCheck.ok) throw new Error(coordinatorCheck.error);
            }

            // Declared skill paths are verbatim (raw) pre-resolution; keep
            // them for the structured claude entries, then resolve once.
            const rawRoleSkillPaths = [...resolvedRole.skillPaths];
            resolvedRole.skillPaths = resolveRequestedSkills(mainRepoRoot, rawRoleSkillPaths, runtime);
            explicitSkillPaths = resolveRequestedSkills(mainRepoRoot, opts.skills ?? [], runtime);

            // Prefer sp's canonical renderer. Older sp versions do not expose
            // render-skill-prefix, so derive the same block from trusted merged
            // role metadata instead of accepting task text that merely looks
            // like a slash command. The prefix is retrieved FIRST so its
            // per-declaration names (sp renders in declaration order) can drive
            // deterministic identity binding before gates and composition.
            const probe = probeSkillPrefixAvailable();
            let spPrefix: string | null = null;
            if (probe.ok) {
                spPrefix = renderSkillPrefix({ role: roleName, runtime, cwd: mainRepoRoot }).skillPrefix;
            }

            let claudeRoleEntries: ClaudePackSkillEntry[] = [];
            let claudeExplicitLines = '';
            if (runtime === 'claude') {
                // Deterministic, order-independent identity binding: role
                // declarations (sp-resolved slot paths) keep their sp prefix
                // name per declaration; explicit requests contribute bare
                // names; one bound name per canonical identity (slot-dir
                // alias preferred when named, else the sole requested name,
                // else runtimeName).
                const prefixNames = spPrefix !== null
                    ? spPrefix.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('/')).map((line) => line.slice(1))
                    : null;
                if (prefixNames !== null && prefixNames.length !== rawRoleSkillPaths.length) {
                    throw new Error(
                        `role '${roleName}': sp skill prefix names do not align with declared skills `
                        + `(${prefixNames.length} prefix names vs ${rawRoleSkillPaths.length} declarations).`,
                    );
                }
                const { roleEntries, explicitEntries } = bindClaudePackNames(
                    mainRepoRoot,
                    rawRoleSkillPaths,
                    prefixNames,
                    opts.skills ?? [],
                    runtime,
                );
                claudeRoleEntries = roleEntries;
                const merged: ClaudePackSkillEntry[] = [];
                const seen = new Set<string>();
                for (const entry of [...roleEntries, ...explicitEntries]) {
                    if (seen.has(entry.canonicalPath)) continue;
                    seen.add(entry.canonicalPath);
                    merged.push(entry);
                }
                claudePackEntries = merged;
                const claudeCombined = [...resolvedRole.skillPaths, ...explicitSkillPaths];
                assertClaudeSkillsDiscoverable(mainRepoRoot, claudeCombined.filter((p) => !isProjectPackSkillPath(mainRepoRoot, p)));
                assertClaudePackSkillsLoadable(mainRepoRoot, claudePackEntries);
            }

            // Reconstruct the claude role block so it carries exactly ONE
            // per-declaration identity command with the deterministic bound
            // name (sp prefix text is never used verbatim: duplicates for one
            // identity are rewritten/removed, non-pack commands preserved in
            // declaration order). Pi keeps the sp/fallback block.
            const trustedSkillPrefix = runtime === 'claude'
                ? composeClaudeRoleBlock(mainRepoRoot, rawRoleSkillPaths, spPrefix?.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('/')).map((line) => line.slice(1)) ?? null, claudeRoleEntries, runtime)
                : (spPrefix ?? renderDeclaredSkillPrefix(resolvedRole.skillPaths, runtime, mainRepoRoot));
            let trustedPrefix = trustedSkillPrefix;

            // Deduped explicit turn-1 lines: identities already covered by the
            // role block (coalesced bound name) and names already present in
            // the role prefix are never re-emitted.
            if (runtime === 'claude') {
                const roleCommandNames = new Set(trustedSkillPrefix
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line.startsWith('/'))
                    .map((line) => line.slice(1)));
                claudeExplicitLines = composeClaudeExplicitLines(mainRepoRoot, explicitSkillPaths, claudePackEntries, roleCommandNames);
            }

            const rawBody = bead
                ? (renderedTask = renderRoleTask({ role: roleName, bead, cwd: mainRepoRoot, runtime })).initialPrompt
                : (prompt ?? '');
            let untrustedBody = rawBody;
            if (bead && probe.ok && trustedSkillPrefix) {
                if (!rawBody.startsWith(trustedSkillPrefix)) {
                    throw new Error('render-task output does not start with the exact trusted sp skill prefix.');
                }
                untrustedBody = rawBody.slice(trustedSkillPrefix.length);
            }
            // Provenance, not path. A bead-derived body carries a bead title
            // that any writer to the beads store can set, so a leading '/'
            // there is an impersonation attempt and stays rejected. An
            // operator-typed --prompt is the same trust level whether or not
            // --role is present — it is argv the operator typed on their own
            // terminal — so it is exempt here exactly as it is in bare mode.
            // This replaces the uniform check with the rule it was always
            // reaching for. xtrm-3xgs5 (see PR #439 for the bare half).
            if (bead) {
                const rawSlashCheck = checkPositionZeroSlash(untrustedBody, runtime, '');
                if (!rawSlashCheck.ok) throw new Error(rawSlashCheck.error);
            }
            composedTurn1Body = trustedSkillPrefix + untrustedBody;

            // Claude explicit --skill delivery is launcher-owned but still
            // derived only from validated, discoverable skill metadata;
            // claudeExplicitLines is identity-deduped against the role block.
            if (runtime === 'claude' && claudeExplicitLines.length > 0) {
                const explicitPrefix = `${claudeExplicitLines}${trustedPrefix ? '\n' : '\n\n'}`;
                composedTurn1Body = explicitPrefix + composedTurn1Body;
                trustedPrefix = explicitPrefix + trustedPrefix;
            }

            // Composition integrity: when a trusted prefix was assembled, the
            // composed body must start with exactly it — that assertion is
            // worth making whatever the body's provenance. With no trusted
            // prefix the check degenerates to the leading-'/' rule, which
            // only an untrusted bead-derived body needs. Both fire before
            // worktree creation.
            if (trustedPrefix || bead) {
                const slashCheck = checkPositionZeroSlash(composedTurn1Body, runtime, trustedPrefix);
                if (!slashCheck.ok) throw new Error(slashCheck.error);
            }

            // Literal prompts keep the conservative 50KB policy. Rendered
            // beads use the larger per-runtime-argument boundary so their full
            // dependency/rule context is not mistaken for literal input.
            const byteCheck = checkByteCeiling({
                systemPrompt: resolvedRole.systemPrompt,
                body: composedTurn1Body,
                source: bead ? 'bead' : 'prompt',
            });
            if (!byteCheck.ok) throw new Error(byteCheck.error);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(kleur.red(`\n  ✗ ${msg}\n`));
            process.exit(1);
        }
    } else {
        try {
            explicitSkillPaths = resolveRequestedSkills(mainRepoRoot, opts.skills ?? [], runtime);
            composedTurn1Body = prompt ?? '';
            let trustedPrefix = '';

            if (runtime === 'claude' && explicitSkillPaths.length > 0) {
                // Pack-tier explicit paths are materialized in the worktree
                // after creation; non-pack paths keep the strict native gate.
                // SEC-03: bare explicit requests route through the same
                // deterministic identity binder (empty role ownership) so
                // dir/file/canonical/slot permutations bind the slot alias
                // order-independently and non-slot aliases reject.
                const { explicitEntries } = bindClaudePackNames(mainRepoRoot, [], null, opts.skills ?? [], runtime);
                claudePackEntries = explicitEntries;
                assertClaudeSkillsDiscoverable(mainRepoRoot, explicitSkillPaths.filter((p) => !isProjectPackSkillPath(mainRepoRoot, p)));
                assertClaudePackSkillsLoadable(mainRepoRoot, claudePackEntries);
                trustedPrefix = `${claudeExplicitLinesFor(mainRepoRoot, explicitSkillPaths, claudePackEntries)}\n\n`;
                composedTurn1Body = trustedPrefix + composedTurn1Body;
            }

            // Bare-mode turn-1 body is entirely trusted at composition:
            // opts.prompt is operator-typed argv on their own terminal, and
            // trustedPrefix is launcher-generated from validated, discoverable
            // --skill args. --bead does not compose anything here (no roleless
            // `sp render-task`), so bare has no untrusted body source *by
            // construction* rather than by accident — which is what makes the
            // absent slash guard safe. A leading '/' in --prompt (e.g.
            // '/multiplexing ...') is the sanctioned way to load a skill on
            // turn 1. The role path keeps the guard on bead-derived bodies.
            // xtrm-8zsi1 follow-up; provenance rule finished in xtrm-3xgs5.
            const byteCheck = checkByteCeiling({
                systemPrompt: '',
                body: composedTurn1Body,
                source: 'prompt',
            });
            if (!byteCheck.ok) throw new Error(byteCheck.error);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(kleur.red(`\n  ✗ ${msg}\n`));
            process.exit(1);
        }
    }

    // The nested-worktree guard and main-root discovery now run before role
    // resolution (SEC-01); the remainder of the launcher uses mainRepoRoot.

    const cwdBasename = path.basename(mainRepoRoot);

    // Resolve slug — shared by both branch and worktree path so they're linked
    const slug = name ?? randomSlug(4);

    // Reuse is resolved before any worktree, branch, or runtime scaffolding is
    // created. Otherwise a successful session reuse leaves the provisional
    // checkout orphaned behind.
    const reuseRequested = Boolean(opts.reuse) && (Boolean(newSession) || !process.env.TMUX);
    if (reuseRequested) {
        const roleSlug = resolvedRole ? slugifyForSession(resolvedRole.name) : null;
        const sessionName = roleSlug
            ? `role-${runtime}-${roleSlug}${bead ? `-${slugifyForSession(bead)}` : ''}`
            : `${runtime}-${slugifyForSession(slug)}`;
        const sessionExists = spawnSync('tmux', ['has-session', '-t', `=${sessionName}`], { stdio: 'pipe' }).status === 0;
        if (sessionExists) {
            const paneQuery = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'], {
                stdio: 'pipe', encoding: 'utf8',
            });
            const existingPane = (paneQuery.stdout ?? '').trim().split('\n')[0] ?? '';
            if (!attach) {
                process.stdout.write(`${sessionName}:${existingPane}\n`);
                process.exit(0);
            }
            const attachResult = spawnSync('tmux', chooseAttachCommand(sessionName, Boolean(process.env.TMUX)), {
                stdio: 'inherit',
            });
            process.exit(attachResult.status ?? 0);
        }
    }

    // Worktree path: inside repo under .xtrm/worktrees/
    const worktreeName = `${cwdBasename}-xt-${runtime}-${slug}`;
    const worktreePath = path.join(mainRepoRoot, '.xtrm', 'worktrees', worktreeName);

    // Branch name
    const branchName = `xt/${slug}`;

    const structuredPathCheck = checkStructuredLaunchPaths({
        json: structuredOutput,
        worktreePath,
        branchName,
    });
    if (!structuredPathCheck.ok) {
        console.error(kleur.red(`\n  ✗ ${structuredPathCheck.error}\n`));
        process.exit(1);
    }

    const runtimeExecutable = structuredOutput ? resolveRuntimeExecutable(runtime) : runtime;
    if (!runtimeExecutable) {
        console.error(kleur.red(`\n  ✗ Could not resolve an absolute ${runtime} executable for structured launch\n`));
        process.exit(1);
    }

    if (!structuredOutput) {
        console.log(kleur.bold(`\n  Launching ${runtime} session`));
        console.log(kleur.dim(`  worktree: ${worktreePath}`));
        console.log(kleur.dim(`  branch:   ${branchName}\n`));
    }

    // Use bd worktree create — sets up git worktree + canonical .beads/redirect in one step.
    // Falls back to plain git worktree add if bd is unavailable or the project has no .beads/.
    if (existsSync(worktreePath)) {
        console.error(kleur.red('\n  ✗ Worktree path already exists. Refusing to reuse stale directory.\n'));
        console.error(kleur.dim(`  path: ${worktreePath}`));
        console.error(kleur.dim('\n  Remediation:'));
        console.error(kleur.dim('    xt worktree doctor'));
        console.error(kleur.dim('    xt worktree clean --orphans --yes\n'));
        process.exit(1);
    }

    // SEC-FINAL-01: record whether THIS invocation creates the branch. A
    // pre-existing xt/<slug> branch may legitimately be reused by design;
    // rollback must never delete a branch it did not create.
    const branchExistedBefore = spawnSync('git', ['rev-parse', '--verify', branchName], {
        cwd: mainRepoRoot, stdio: 'pipe',
    }).status === 0;
    const branchCreatedByLauncher = !branchExistedBefore;

    const bdResult = spawnSync('bd', ['worktree', 'create', worktreePath, '--branch', branchName], {
        cwd: mainRepoRoot, stdio: structuredOutput ? 'pipe' : 'inherit',
    });

    if (bdResult.error || bdResult.status !== 0) {
        // Fall back to plain git worktree add (bd not found or no .beads/ in project)
        if (bdResult.status !== 0 && !bdResult.error) {
            if (!structuredOutput) console.log(kleur.dim('  beads: no database found, creating worktree without redirect'));
        }
        const branchExists = spawnSync('git', ['rev-parse', '--verify', branchName], {
            cwd: mainRepoRoot, stdio: 'pipe',
        }).status === 0;

        const gitArgs = branchExists
            ? ['worktree', 'add', worktreePath, branchName]
            : ['worktree', 'add', '-b', branchName, worktreePath];

        const gitResult = spawnSync('git', gitArgs, {
            cwd: mainRepoRoot,
            stdio: structuredOutput ? 'pipe' : 'inherit',
        });
        if (gitResult.status !== 0) {
            console.error(kleur.red(`\n  ✗ Failed to create worktree at ${worktreePath}\n`));
            process.exit(1);
        }
    }

    // Normalize parent's core.hooksPath to absolute if it's still the bd
    // relative default — safety net for older bd installs (see xtrm-2s44).
    normalizeParentHooksPath(mainRepoRoot);

    // Remove worktree-local .beads/ entirely. bd inside the worktree resolves
    // its DB via git common-dir discovery (shared-server mode + absolute
    // core.hooksPath at the parent's .beads/hooks/), so no on-disk .beads/ is
    // needed. The previous dir->symlink approach made bd happy but caused a
    // serious merge hazard: any commit/PR carrying the .beads symlink (mode
    // 120000) wipes the parent's .beads/ on squash-merge (see infra repo PR
    // #39, 2026-05-12). With the directory gone, the tracked .beads/* paths
    // are masked via skip-worktree so the index/worktree delta does not
    // surface in `git status` or checkpoint diffs.
    // See xtrm-cbjo (this fix) supersedes xtrm-as7d / xtrm-nsca / unitAI-u08e8.
    try {
        rmSync(path.join(worktreePath, '.beads'), { recursive: true, force: true });
        markPathSkipWorktree(worktreePath, '.beads');
    } catch {
        // Non-fatal: bd will recover via git common-dir resolution regardless.
    }

    const metadataPersisted = writeSessionMeta(worktreePath, runtime);
    if (!structuredOutput) {
        console.log(kleur.green(`\n  ✓ Worktree ready — launching ${runtime}...\n`));
        console.log(kleur.dim('  note: clean git worktrees do not include ignored dependency dirs like node_modules/ or .venv/'));
        console.log(kleur.dim('        if lint/tests need them, run this repo\'s normal bootstrap inside the worktree (make bootstrap, just setup, npm ci, uv sync, etc.)\n'));
    }

    // Pi runtime bootstrap is handled globally. Project dependency setup is still repo-owned.
    // - Extensions: globally linked (~/.pi/agent/extensions/ → repo)
    // - Packages: installed globally at ~/.pi/agent/npm/
    // Worktree inherits both from global locations.

    // Claude-only scaffold. Pi role sessions now receive absolute --skill
    // paths from resolveRole(), so they no longer need worktree-local
    // .specialists/ or .xtrm/skills/active scaffolds.
    // SEC-06: post-creation provisioning is transactional — any hard failure
    // (pack-skill link conflict, preflight rejection) removes the freshly
    // created worktree and its branch instead of leaving orphan state.
    try {
    if (runtime === 'claude') {
        // 1. Rebuild generated runtime skills view and pointer inside worktree.
        try {
            if (shouldUseGlobalSkills(worktreePath) && !worktreeHasProjectUserPacks(worktreePath)) {
                verifyGlobalPointer();
            } else {
                await ensureAgentsSkillsSymlink(worktreePath);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const warning = kleur.dim(`  warning: could not reconcile runtime skills (${message})`);
            if (structuredOutput) console.error(warning); else console.log(warning);
        }

        // 1b. Materialize launcher-owned links for pack-tier skills so the
        //     pane can load declared/requested '/<name>' commands. Required
        //     startup state: a conflict here fails the launch (never start
        //     with a dead or wrong slash).
        ensureClaudePackSkillLinks(worktreePath, mainRepoRoot, claudePackEntries);

        // 2. Symlink specialist definition directories into worktree so
        //    SpecialistLoader can resolve .specialists/default|user from cwd.
        try {
            ensureWorktreeSpecialists(worktreePath, mainRepoRoot);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const warning = kleur.dim(`  warning: could not provision specialist definitions (${message})`);
            if (structuredOutput) console.error(warning); else console.log(warning);
        }

        // Statusline is owned globally (~/.xtrm/hooks/statusline.mjs via
        // ensureGlobalStatusLine) — no worktree-local settings.local.json write.
    }

    if (runtime === 'pi') {
        await runPiLaunchPreflight(worktreePath, false);
    }
    } catch (error) {
        // Roll back the launcher-created worktree (and its branch only when
        // this invocation created the branch — a pre-existing reused
        // xt/<slug> ref must survive provisioning failure, SEC-FINAL-01).
        rollbackLauncherWorktree(mainRepoRoot, worktreePath, branchName, branchCreatedByLauncher);
        throw error;
    }

    // One decision, taken once: a role launch always needs the tmux path
    // (metadata, telemetry, buffered transport for the system prompt). A bare
    // launch needs it only when something has to be carried into the pane —
    // a turn-1 body, a runtime override, bead metadata, passthrough argv, or
    // a detached/forced-new session. A plain `xt claude <name>` with none of
    // those still gets a plain runtime in the current terminal. xtrm-3xgs5.
    const common = {
        runtime,
        runtimeExecutable,
        sessionDisplayName: worktreeName,
        sessionSlug: slug,
        bead,
        attach,
        worktreePath,
        branchName,
        metadataPersisted,
        modelOverride: model,
        thinkingOverride: thinking,
        turn1Body: composedTurn1Body,
        explicitSkillPaths,
        passthrough: guardedPassthrough,
        newSession,
        reuse: opts.reuse,
        parent: opts.parent,
        child,
        json: structuredOutput,
    };

    if (resolvedRole) {
        await launchTmuxSession({ ...common, mode: 'role', role: resolvedRole, renderedTask });
        return; // launchTmuxSession never returns (calls process.exit)
    }

    const carriesLaunchState = Boolean(prompt) || Boolean(bead) || Boolean(model)
        || Boolean(thinking) || explicitSkillPaths.length > 0
        || guardedPassthrough.length > 0 || !attach || Boolean(newSession);
    if (carriesLaunchState) {
        await launchTmuxSession({ ...common, mode: 'bare' });
        return;
    }

    // Launch the runtime in the worktree. Launcher-owned --name (worktree slug)
    // is first; claude also needs its permission skip. xtrm-rhmm1.
    const runtimeCmd = runtime === 'claude' ? 'claude' : 'pi';
    const runtimeArgs = ['--name', worktreeName];
    if (runtime === 'claude') runtimeArgs.push('--dangerously-skip-permissions');
    const launchResult = spawnSync(runtimeCmd, runtimeArgs, {
        cwd: worktreePath,
        stdio: 'inherit',
    });

    process.exit(launchResult.status ?? 0);
}

/**
 * Resolve a --parent target (session name, id, or `#{session_id}` string) to
 * a concrete tmux session id via `tmux display-message`. Returns null on
 * failure so the launcher can print a clear error before spawning pi.
 * xtmux-1lb.5.1.
 */
function resolveParentSession(target: string): string | null {
    if (/^\$\d+$/.test(target)) return target; // already a sid
    const r = spawnSync('tmux', ['display-message', '-p', '-t', target, '#{session_id}'], {
        stdio: 'pipe', encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    const sid = (r.stdout ?? '').trim();
    return sid || null;
}

/**
 * Fire-and-forget log emission via tmux-session-picker. Non-fatal if the
 * picker binary is missing — the launcher must not fail the user's launch on
 * observability. xtmux-1lb.5.1.
 */
function emitAgentRoleLaunched(fields: Record<string, string>): void {
    const picker = process.env.XTMUX_PICKER
        || path.join(os.homedir(), '.local', 'bin', 'tmux-session-picker');
    if (!existsSync(picker)) return;
    const kvArgs = Object.entries(fields)
        .filter(([, v]) => v !== '' && v != null)
        .map(([k, v]) => `${k}=${v}`);
    spawnSync(picker, ['log', 'emit', 'agent.role.launched', ...kvArgs], {
        stdio: 'ignore',
    });

    if (fields.task_prompt_renderer) {
        const taskFields = [
            'pane', 'session', 'bead', 'role',
            'task_prompt_renderer', 'task_prompt_hash', 'task_prompt_components',
        ].flatMap((key) => fields[key] ? [`${key}=${fields[key]}`] : []);
        spawnSync(picker, ['log', 'emit', 'agent.role.task-rendered', ...taskFields], {
            stdio: 'ignore',
        });
    }
}

/**
 * Launch args. The role/bare distinction is carried in the type rather than
 * in a nullable `role?` plus a pile of `role?.x` reads — a bare launch simply
 * has no role to speak of, and the union makes that unrepresentable rather
 * than merely undefined. xtrm-3xgs5.
 */
type TmuxLaunchArgs = {
    runtime: 'pi' | 'claude';
    runtimeExecutable: string;
    sessionDisplayName: string;
    sessionSlug: string;
    bead?: string;
    attach: boolean;
    worktreePath: string;
    branchName: string;
    metadataPersisted: boolean;
    modelOverride?: string;
    thinkingOverride?: string;
    /** Composed turn-1 positional body (sp prefix + user body). Empty = skills-only prime. */
    turn1Body: string;
    explicitSkillPaths?: string[];
    passthrough?: string[];
    newSession?: boolean;
    parent?: string;
    child?: boolean;
    reuse?: boolean;
    json?: boolean;
} & (
    | {
        mode: 'role';
        role: ResolvedRole;
        /** render-task metadata for telemetry only (turn1Body owns the actual body). */
        renderedTask?: RenderedRoleTask;
    }
    | { mode: 'bare' }
);

async function launchTmuxSession(args: TmuxLaunchArgs): Promise<never> {
    const {
        runtime, runtimeExecutable, sessionDisplayName, sessionSlug, bead, attach, worktreePath, branchName, metadataPersisted, modelOverride, thinkingOverride, turn1Body, explicitSkillPaths = [], passthrough,
        newSession, parent, child, reuse, json: structuredOutput = false,
    } = args;

    const insideTmux = Boolean(process.env.TMUX);
    // Current-pane mode: inside $TMUX with no explicit --new-session. This is
    // the new default — matches operator intent "if i'm in tmux and want a
    // role, launch it in this pane and that's that." Outside $TMUX the only
    // sensible thing is still `tmux new-session`, so mode collapses to
    // new-session there regardless of --new-session. xtmux-1lb.5.1.
    const currentPaneMode = insideTmux && !newSession && (args.mode === 'role' || attach);

    // Guard: --no-attach only makes sense when we're actually creating a
    // session that could be attached-to later. In current-pane mode there IS
    // no separate session, so --no-attach has nowhere to go.
    if (currentPaneMode && !attach) {
        process.stderr.write(kleur.red(
            `\n  ✗ --no-attach requires --new-session (or exit tmux first)\n`,
        ));
        process.exit(1);
    }

    // Resolve parent session id. Precedence: --parent wins over --child
    // wins over auto (current session).
    let parentSessionId: string;
    if (parent) {
        const resolved = resolveParentSession(parent);
        if (!resolved) {
            process.stderr.write(kleur.red(
                `\n  ✗ --parent '${parent}': tmux session not found\n`,
            ));
            process.exit(1);
        }
        parentSessionId = resolved;
    } else if (child) {
        // Explicit form of the auto-behavior. Kept as an opt-in so a future
        // default flip (to 'no auto-parent') doesn't break scripts.
        parentSessionId = currentTmuxSessionId();
    } else {
        parentSessionId = currentTmuxSessionId();
    }

    // Fileless transport within a trusted same-user control plane. Current-pane
    // mode passes argv directly; the role new-session path uses a transient
    // tmux buffer to keep a 50-1000KB system prompt off the command line.
    // Prompts/beads are not credential storage, and same-server tmux peers are
    // trusted to inspect or control the session.

    const planCommon = {
        runtime, sessionDisplayName, bead, parentSessionId, worktreePath, branchName,
        turn1Body, modelOverride, thinkingOverride, explicitSkillPaths, passthrough,
    };
    const plan = args.mode === 'role'
        ? buildRoleTmuxPlan({ ...planCommon, role: args.role })
        : buildBareTmuxPlan({ ...planCommon, sessionSlug });
    const runtimeCmdString = [runtimeExecutable, ...plan.runtimeArgs].map(shellQuote).join(' ');

    const agentEnv = buildAgentEnv(plan.paneOptions);

    if (currentPaneMode) {
        // Resolve the current pane id (the pane the launcher was invoked
        // from). All @agent_* pane options get written here; pi then runs
        // in this same pane with stdio inherited.
        const paneQuery = spawnSync('tmux', ['display-message', '-p', '#{pane_id}'], {
            stdio: 'pipe', encoding: 'utf8',
        });
        const paneId = (paneQuery.stdout ?? '').trim();
        if (!paneId) {
            process.stderr.write(kleur.red('\n  ✗ Could not resolve current pane id\n'));
            process.exit(1);
        }

        const previousInstanceId = bead
            ? (spawnSync('tmux', ['show-options', '-p', '-t', paneId, '-qv', '@agent_instance_id'], {
                encoding: 'utf8', stdio: 'pipe',
            }).stdout ?? '').trim()
            : '';
        for (const { key, value } of plan.paneOptions) {
            spawnSync('tmux', ['set-option', '-p', '-t', paneId, key, value], { stdio: 'pipe' });
        }

        if (args.mode === 'role') {
            emitAgentRoleLaunched({
                pane: paneId,
                session: currentTmuxSessionId(),
                bead: bead ?? '',
                role: args.role.name,
                parent: parentSessionId,
                worktree: worktreePath,
                branch: branchName,
                task_prompt_renderer: args.renderedTask ? 'success' : 'not_requested',
                task_prompt_hash: args.renderedTask?.promptHash ?? '',
                task_prompt_components: args.renderedTask ? JSON.stringify(args.renderedTask.components) : '',
            });
        }

        if (!bead) {
            const runtimeResult = spawnSync(runtimeExecutable, plan.runtimeArgs, {
                cwd: worktreePath,
                stdio: 'inherit',
                env: { ...process.env, ...agentEnv },
            });
            process.exit(runtimeResult.status ?? 0);
        }

        // Before spawn, not after: the runtime's agent.ready fires once, and a
        // watermark taken later could reject it. See AssignBeadOptions.readyAfterMs.
        const readyAfterMs = Date.now();
        const runtimeProcess = spawn(runtimeExecutable, plan.runtimeArgs, {
            cwd: worktreePath,
            stdio: 'inherit',
            env: { ...process.env, ...agentEnv },
        });
        const runtimeExit = new Promise<number>((resolve) => {
            runtimeProcess.once('error', () => resolve(1));
            runtimeProcess.once('exit', code => resolve(code ?? 1));
        });
        await assignBeadToRuntime(bead, runtime, paneId, worktreePath, { previousInstanceId, readyAfterMs });
        process.exit(await runtimeExit);
    }

    // New-session path (default outside $TMUX, or --new-session inside).
    // On session-name collision two operator-friendly outcomes replace the
    // pre-xtmux-1lb.6 hard-refuse:
    //   --reuse         attach to the existing session (no new worktree work)
    //   default         auto-suffix `-<hex>` and create a fresh sibling
    // The worktree naming already generates unique hex suffixes; session
    // naming now mirrors that so `xt pi --role X` twice in a row does the
    // sane thing.
    const sessionExists = (name: string): boolean => {
        const r = spawnSync('tmux', ['has-session', '-t', `=${name}`], { stdio: 'pipe' });
        return r.status === 0;
    };
    if (sessionExists(plan.sessionName)) {
        if (reuse) {
            // Attach to the existing session (or --no-attach: print its
            // first-pane coordinates). Do NOT emit agent.role.launched —
            // the session isn't ours and metadata isn't guaranteed.
            const paneQuery = spawnSync('tmux', [
                'list-panes', '-t', plan.sessionName, '-F', '#{pane_id}',
            ], { stdio: 'pipe', encoding: 'utf8' });
            const existingPane = (paneQuery.stdout ?? '').trim().split('\n')[0] ?? '';
            if (!attach) {
                process.stdout.write(`${plan.sessionName}:${existingPane}\n`);
                process.exit(0);
            }
            const attachCmd = chooseAttachCommand(plan.sessionName, insideTmux);
            const attachResult = spawnSync('tmux', attachCmd, { stdio: 'inherit' });
            process.exit(attachResult.status ?? 0);
        }
        // Auto-suffix. Try a handful of random slugs — collisions on
        // 4-hex-char slugs are astronomically unlikely, but bail loudly if
        // the operator has genuinely tens of sessions all sharing a prefix.
        let suffixed = plan.sessionName;
        let found = false;
        for (let i = 0; i < 10; i++) {
            const candidate = `${plan.sessionName}-${randomSlug(4)}`;
            if (!sessionExists(candidate)) {
                suffixed = candidate;
                found = true;
                break;
            }
        }
        if (!found) {
            process.stderr.write(kleur.red(
                `\n  ✗ Could not find a free session name variant for '${plan.sessionName}' — kill some or pass --reuse\n`,
            ));
            process.exit(1);
        }
        plan.sessionName = suffixed;
    }

    // Pass XTMUX_AGENT_* through to the new session's environment via -e so
    // scripts/agent-state.sh (running inside the new pane) can pick them up.
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(agentEnv)) {
        envArgs.push('-e', `${k}=${v}`);
    }

    // A tmux session started by `new-session` inherits the tmux SERVER's
    // environment, not this process's, so an operator's exported
    // XTRM_SUBSTRATE_DIR never reached the launched runtime. Without it
    // specialist_dispatch inside the session is refused outright with
    // work_item_store_unavailable, so forward it explicitly. Absent or empty
    // stays absent — substrate resolution has its own fallbacks. XTRM-249.
    const substrateDir = process.env.XTRM_SUBSTRATE_DIR;
    if (substrateDir) envArgs.push('-e', `XTRM_SUBSTRATE_DIR=${substrateDir}`);

    // Transport. The buffered handshake exists so a 50-1000KB role system
    // prompt never has to fit on a command line: tmux starts a consumer
    // wrapper, we hand it the payload through a transient buffer, and it
    // execs the runtime. A bare launch has no system prompt at all and its
    // turn-1 body is already bounded by the 50KB literal ceiling
    // (checkByteCeiling source:'prompt') — the very constant tmux's own
    // command-length limit motivated. So bare hands tmux the shell-quoted
    // command line directly, exactly as current-pane mode already hands argv
    // to spawnSync, and skips four sync-points and a wrapper subprocess.
    // xtrm-3xgs5.
    let runtimeBuffer: string | null = null;
    const cleanupOnSignal = (): void => {
        if (runtimeBuffer) deleteRuntimeBuffer(runtimeBuffer);
        spawnSync('tmux', ['kill-session', '-t', plan.sessionName], { stdio: 'ignore' });
        process.exit(1);
    };
    process.once('SIGINT', cleanupOnSignal);
    process.once('SIGTERM', cleanupOnSignal);
    process.once('SIGHUP', cleanupOnSignal);

    const failNewSession = (stderr: string): never => {
        if (runtimeBuffer) deleteRuntimeBuffer(runtimeBuffer);
        process.stderr.write(kleur.red(`\n  ✗ tmux new-session failed: ${stderr || 'unknown error'}\n`));
        process.exit(1);
    };

    // Before the pane exists, so it strictly precedes any runtime start on either
    // transport. See AssignBeadOptions.readyAfterMs.
    const readyAfterMs = Date.now();

    if (args.mode === 'bare') {
        const newSess = spawnSync('tmux', [
            'new-session', '-d',
            '-s', plan.sessionName,
            '-c', worktreePath,
            ...envArgs,
            runtimeCmdString,
        ], { stdio: 'pipe', encoding: 'utf8' });
        if (newSess.status !== 0) failNewSession((newSess.stderr ?? '').trim());
    } else {
        runtimeBuffer = createRuntimeBufferName();
        const newSess = spawnSync('tmux', [
            'new-session', '-d',
            '-s', plan.sessionName,
            '-c', worktreePath,
            ...envArgs,
            buildBufferedRuntimeCommand(runtimeBuffer),
        ], { stdio: 'pipe', encoding: 'utf8' });
        if (newSess.status !== 0) failNewSession((newSess.stderr ?? '').trim());

        const consumerReady = spawnSync('tmux', ['wait-for', `${runtimeBuffer}-consumer-ready`], {
            stdio: 'pipe',
            encoding: 'utf8',
            timeout: TMUX_CONSUMER_READY_TIMEOUT_MS,
            killSignal: 'SIGTERM',
        });
        if (consumerReady.status !== 0) {
            deleteRuntimeBuffer(runtimeBuffer);
            spawnSync('tmux', ['kill-session', '-t', plan.sessionName], { stdio: 'ignore' });
            const stderr = (consumerReady.stderr ?? consumerReady.error?.message ?? '').trim() || 'consumer readiness timed out';
            process.stderr.write(kleur.red(`\n  ✗ tmux prompt consumer failed to become ready: ${stderr}\n`));
            process.exit(1);
        }

        const bufferedPayload = JSON.stringify({
            runtimeCmd: runtimeExecutable,
            runtimeArgs: plan.runtimeArgs,
        });
        const loaded = spawnSync('tmux', ['load-buffer', '-b', runtimeBuffer, '-'], {
            input: bufferedPayload,
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf8',
        });
        const signaled = loaded.status === 0
            ? spawnSync('tmux', ['wait-for', '-S', `${runtimeBuffer}-ready`], { stdio: 'pipe', encoding: 'utf8' })
            : null;
        if (loaded.status !== 0 || signaled?.status !== 0) {
            deleteRuntimeBuffer(runtimeBuffer);
            spawnSync('tmux', ['kill-session', '-t', plan.sessionName], { stdio: 'ignore' });
            const stderr = ((loaded.stderr ?? signaled?.stderr) as string | undefined)?.trim() || 'unknown error';
            process.stderr.write(kleur.red(`\n  ✗ tmux prompt transport failed: ${stderr}\n`));
            process.exit(1);
        }
    }

    const paneQuery = spawnSync('tmux', [
        'list-panes', '-t', plan.sessionName, '-F', '#{pane_id}',
    ], { stdio: 'pipe', encoding: 'utf8' });
    const paneId = (paneQuery.stdout ?? '').trim().split('\n')[0] ?? '';
    if (!paneId) {
        if (runtimeBuffer) deleteRuntimeBuffer(runtimeBuffer);
        spawnSync('tmux', ['kill-session', '-t', plan.sessionName], { stdio: 'ignore' });
        process.stderr.write(kleur.red('\n  ✗ Could not resolve pane id for new session\n'));
        process.exit(1);
    }

    process.off('SIGINT', cleanupOnSignal);
    process.off('SIGTERM', cleanupOnSignal);
    process.off('SIGHUP', cleanupOnSignal);

    for (const { key, value } of plan.paneOptions) {
        spawnSync('tmux', ['set-option', '-p', '-t', paneId, key, value], { stdio: 'pipe' });
    }
    if (bead) await assignBeadToRuntime(bead, runtime, paneId, worktreePath, { readyAfterMs });

    if (args.mode === 'role') {
        emitAgentRoleLaunched({
            pane: paneId,
            session: plan.sessionName,
            bead: bead ?? '',
            role: args.role.name,
            parent: parentSessionId,
            worktree: worktreePath,
            branch: branchName,
            task_prompt_renderer: args.renderedTask ? 'success' : 'not_requested',
            task_prompt_hash: args.renderedTask?.promptHash ?? '',
            task_prompt_components: args.renderedTask ? JSON.stringify(args.renderedTask.components) : '',
        });
    }

    if (!attach) {
        // Detached output remains exactly one line: the released
        // session_name:pane_id text, or the opt-in versioned JSON object.
        if (structuredOutput) {
            const sessionIdResult = spawnSync('tmux', [
                'list-sessions', '-F', '#{session_name}\t#{session_id}',
            ], { stdio: 'pipe', encoding: 'utf8' });
            const sessionIdentity = parseLiveTmuxSessionListing(
                sessionIdResult.status,
                sessionIdResult.stdout ?? '',
                plan.sessionName,
            );
            if (!sessionIdentity.ok) {
                process.stderr.write(kleur.red(`\n  ✗ ${sessionIdentity.error}\n`));
                process.exit(1);
            }
            const tmuxSessionId = sessionIdentity.sessionId;
            const versionResult = spawnSync(runtimeExecutable, ['--version'], {
                cwd: worktreePath,
                stdio: 'pipe',
                encoding: 'utf8',
                timeout: 5_000,
            });
            const runtimeVersionLine = versionResult.status === 0
                ? (versionResult.stdout ?? '').trim().split(/\r?\n/, 1)[0]?.slice(0, 128) ?? ''
                : '';
            const runtimeVersion = sanitizeRuntimeVersion(runtimeVersionLine);
            const outcome = buildDetachedLaunchOutcome({
                runtime,
                runtimeVersion,
                sessionSlug,
                sessionName: plan.sessionName,
                tmuxSessionId,
                paneId,
                worktreePath,
                branchName,
                metadataPersisted,
                insideTmux,
            });
            process.stdout.write(`${JSON.stringify(outcome)}\n`);
        } else {
            process.stdout.write(`${plan.sessionName}:${paneId}\n`);
        }
        process.exit(0);
    }

    const attachCmd = chooseAttachCommand(plan.sessionName, insideTmux);
    const attachResult = spawnSync('tmux', attachCmd, {
        stdio: 'inherit',
    });
    process.exit(attachResult.status ?? 0);
}
