/**
 * Substrate (`sb`) consumer boundary for Core.
 *
 * Core consumes Substrate; it must not implement another issue tracker
 * (ADR section 6). Every function here shells out to the `sb` CLI, the
 * `setup.ts` integration contract, or the one-way `bd export` intake —
 * nothing else.
 *
 * Verified against live `sb 0.1.0` (@xtrm/substrate, xtrm PR #163) plus the
 * A6 setup contract (xtrm PR #168):
 * - `sb --version [--json]` exits 0 with parseable `sb <semver>` output and
 *   no side effects.
 * - `sb --help` / `sb help [group [verb]] [--json]` exit 0 and create nothing
 *   even with HOME=/empty.
 * - Every `--json` response is the envelope
 *   `{schema: "substrate-cli/v1", command, ok, data?|error?}` — the envelope
 *   is the machine contract; human text is a human aid.
 * - `sb doctor [--db PATH] [--json]` exits 0 only when the schema is healthy;
 *   data is `{dbPath, schemaHealthy, schemaError, projects, link, linkError,
 *   gitRoot}`, link is `{projectId, source, gitRoot}`.
 * - `sb project create --prefix <PREFIX> --name <name> [--id <id>]`,
 *   `sb project link [--project <id>]` (cwd checkout; implicit on
 *   single-project DBs), `sb project unlink`. No `project list` verb
 *   exists — link state comes from `sb doctor --json` data.link.
 * - `sb import beads --file <export.jsonl> --project <id> ... --json`
 *   (import activation owned by xtrm-6qu.9; A8 never invokes it).
 *   `--dry-run` reports `{dryRun, records, edges}` without mutating;
 *   real runs return `{created[], skippedPresent[], edgesApplied[],
 *   edgeErrors[], unready[]}` and are idempotent via alias presence.
 *   `--file` is a Beads JSONL export (`bd export -o`), edges are
 *   `{issue_id, depends_on_id, type}`. The `--json` envelope holds only
 *   with `--json`; without it sb prints bare human JSON by design.
 * - A6 `node <@xtrm/substrate>/integrations/setup.ts check --json` reports
 *   `{ok, claude: Check[], pi: Check[], naming: {substratePlugins[],
 *   beadsRemnants[], duplicates}}`, exit 0/1; `plan --json` reports the
 *   declarative install plan for `xt init`.
 *
 * Test hermetics: all entry points accept an injected runner. Tests inject
 * stub runners or point `XTRM_SB_BIN` / `XTRM_SUBSTRATE_SETUP` at fixture
 * scripts — no test ever requires a real `sb` binary.
 */

import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

export interface SbExecResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: string;
}

export type SbRunner = (args: string[], opts?: { cwd?: string; timeout?: number; bin?: string }) => SbExecResult;

/** Override the `sb` binary path (tests point this at a fixture script). */
export function resolveSbBin(): string {
    return process.env.XTRM_SB_BIN ?? 'sb';
}

export function defaultSbRunner(args: string[], opts: { cwd?: string; timeout?: number; bin?: string } = {}): SbExecResult {
    const result = spawnSync(opts.bin ?? resolveSbBin(), args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: opts.timeout ?? 10000,
    });
    if (result.error) {
        return { status: result.status, stdout: '', stderr: '', error: (result.error as Error).message };
    }
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/** `--json` machine envelope (verified against live `sb 0.1.0`). */
export interface SbEnvelope<T = unknown> {
    schema?: string;
    command?: string;
    ok?: boolean;
    data?: T;
    error?: string;
}

/** Best-effort envelope parse: never throws, never guesses. */
export function parseSbEnvelope<T = unknown>(stdout: string): SbEnvelope<T> | null {
    try {
        const parsed = JSON.parse(stdout) as SbEnvelope<T>;
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

export function extractSbVersion(text: string): string | undefined {
    return text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

export interface SbVersionInfo {
    /** True only when `sb --version` exits 0 (the confirmed contract). */
    available: boolean;
    version?: string;
    raw: string;
}

export function getSbVersion(run: SbRunner = defaultSbRunner): SbVersionInfo {
    const result = run(['--version'], { timeout: 5000 });
    if (result.status !== 0) {
        return { available: false, raw: (result.stderr || result.error || '').trim() };
    }
    const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n')[0]?.trim() ?? '';
    return { available: true, version: extractSbVersion(raw), raw };
}

/** ADR-grounded default: `xt init` initializes `~/.xtrm/state.db`. */
export function defaultStateDbPath(home: string = os.homedir()): string {
    return path.join(home, '.xtrm', 'state.db');
}

export function stateDbPresent(dbPath: string = defaultStateDbPath()): boolean {
    try {
        return fs.pathExistsSync(dbPath);
    } catch {
        return false;
    }
}

/** `sb doctor --json` data payload (verified against live `sb 0.1.0`). */
export interface SbDoctorData {
    dbPath?: string;
    schemaHealthy?: boolean;
    schemaError?: string | null;
    projects?: number | null;
    link?: { projectId?: string; source?: string; gitRoot?: string } | null;
    linkError?: string | null;
    gitRoot?: string | null;
}

export interface SbDoctorInfo {
    /**
     * True only when exit 0 AND the envelope parses AND `ok` is true AND
     * `data.schemaHealthy` is true. Anything else fails closed.
     */
    ok: boolean;
    /** Verbatim envelope (the machine contract). */
    payload: SbEnvelope<SbDoctorData> | null;
    /** Interpreted data keys; null unless the envelope parsed. */
    data: SbDoctorData | null;
    raw: string;
    error?: string;
}

export function getSbDoctorJson(cwd?: string, run: SbRunner = defaultSbRunner): SbDoctorInfo {
    const result = run(['doctor', '--json'], { cwd, timeout: 15000 });
    const raw = String(result.stdout ?? '');
    const fail = (error: string): SbDoctorInfo => ({ ok: false, payload: null, data: null, raw, error });
    if (result.status !== 0) {
        // The unhealthy envelope still carries data; parse it for diagnosis.
        const payload = parseSbEnvelope<SbDoctorData>(raw);
        if (payload && payload.data && typeof payload.data === 'object') {
            return { ok: false, payload, data: payload.data, raw, error: (result.stderr || payload.error || `sb doctor exited ${result.status}`).trim() };
        }
        return fail((result.stderr || result.error || `sb doctor exited ${result.status}`).trim());
    }
    const payload = parseSbEnvelope<SbDoctorData>(raw);
    if (!payload) return fail('sb doctor --json emitted unparseable JSON');
    const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
    if (payload.ok !== true || !data || data.schemaHealthy !== true) {
        return { ok: false, payload, data, raw, error: payload.error ?? data?.schemaError ?? 'sb doctor reported unhealthy state' };
    }
    return { ok: true, payload, data, raw };
}

export interface SbProjectLinkInfo {
    /**
     * Project link resolved from `sb doctor --json` data.link — the CLI has
     * no `project list` verb (only create|link|unlink), so doctor is the
     * read surface for link state (verified against live `sb 0.1.0`).
     */
    ok: boolean;
    projectId: string | null;
    source: string | null;
    error?: string;
}

export function getSbProjectLink(cwd?: string, run: SbRunner = defaultSbRunner): SbProjectLinkInfo {
    const doctor = getSbDoctorJson(cwd, run);
    if (!doctor.ok || !doctor.data) {
        return { ok: false, projectId: null, source: null, error: doctor.error ?? 'sb doctor --json rejected' };
    }
    const link = doctor.data.link;
    if (!link || !link.projectId) {
        return { ok: false, projectId: null, source: link?.source ?? null, error: doctor.data.linkError ?? 'no linked project for this checkout' };
    }
    return { ok: true, projectId: link.projectId, source: link.source ?? null };
}

/**
 * Link the cwd checkout to a Substrate project.
 * Flags verified: `sb project link [--project <id>]` — no flags links
 * implicitly on single-project DBs (live `sb 0.1.0`). Fail-open reporting:
 * callers decide whether a missing link blocks them.
 */
export function linkSbProject(opts: { project?: string; cwd?: string; run?: SbRunner } = {}): { ok: boolean; raw: string; error?: string } {
    const args = ['project', 'link', ...(opts.project ? ['--project', opts.project] : [])];
    const result = (opts.run ?? defaultSbRunner)(args, { cwd: opts.cwd, timeout: 15000 });
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.status !== 0) {
        return { ok: false, raw, error: (result.stderr || result.error || `sb project link exited ${result.status}`).trim() };
    }
    return { ok: true, raw };
}

/**
 * Parse an init `--sb-create-project PREFIX:Name` value. Returns null when
 * the shape is wrong — callers report the usage error, never guess.
 */
export function parseCreateProjectFlag(value: string): { prefix: string; name: string } | null {
    const trimmed = value.trim();
    const sep = trimmed.indexOf(':');
    if (sep <= 0) return null;
    const prefix = trimmed.slice(0, sep).trim();
    const name = trimmed.slice(sep + 1).trim();
    if (!prefix || !name || /\s/.test(prefix)) return null;
    return { prefix, name };
}

/**
 * Create a Substrate project.
 * Flags verified: `sb project create --prefix <PREFIX> --name <name>
 * [--id <id>]`. The caller supplies prefix/name — this module never invents
 * project identity.
 */
export function createSbProject(opts: { prefix: string; name: string; id?: string; cwd?: string; run?: SbRunner }): { ok: boolean; raw: string; projectId?: string; error?: string } {
    const args = ['project', 'create', '--prefix', opts.prefix, '--name', opts.name, ...(opts.id ? ['--id', opts.id] : [])];
    const result = (opts.run ?? defaultSbRunner)(args, { cwd: opts.cwd, timeout: 15000 });
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.status !== 0) {
        return { ok: false, raw, error: (result.stderr || result.error || `sb project create exited ${result.status}`).trim() };
    }
    // create emits {"id":...}: callers link the created id explicitly so a
    // non-empty store can never make the follow-up link ambiguous.
    let projectId: string | undefined;
    try {
        const parsed = JSON.parse(result.stdout ?? '') as { id?: unknown };
        if (parsed && typeof parsed.id === 'string' && parsed.id) projectId = parsed.id;
    } catch { /* unparseable: callers fail closed on missing id, never a bare link */ }
    return { ok: true, raw, projectId };
}

// NOTE (amended A8/A9 contract): the legacy import invocation surface was
// removed from A8. Import activation, preservation verification, receipt
// interpretation, and cleanup are owned by xtrm-6qu.9 (A9); A8 fails closed
// on legacy `.beads` repos via migrationBlockedReason. Documented verified
// flags for the A9 implementer: `sb import beads --file <export.jsonl>
// --project <id> [--edges-file <f>] [--create-project <PREFIX:Name>]
// [--dry-run] --json` (envelope only with --json; the bare-object human
// path is by design — always pass --json).

// -- A6 integration contract (xtrm PR #168, integrations/setup.ts) ----------

export interface SetupCheckItem {
    name: string;
    ok: boolean;
    detail?: string;
}

export interface SetupCheckReport {
    ok: boolean;
    claude: SetupCheckItem[];
    pi: SetupCheckItem[];
    naming: { substratePlugins: Array<{ name: string; source: string }>; beadsRemnants: string[]; duplicates: boolean };
    /** Additive in #174: validated source dir + per-item enrollment results. */
    dir?: string;
    enrollment?: SetupCheckItem[];
}

/** The six contract enrollment probes (setup.ts #174). Every one must be
 * present and ok: old source-only reports without this contract are not
 * enrollment proof. */
export const EXPECTED_ENROLLMENT_ITEMS = [
    'sb-enrolled',
    'pi-enrolled',
    'claude-marketplace-enrolled',
    'claude-plugin-enrolled',
    'claude-strict-live',
    'beads-absent',
];

export interface SetupCheckInfo {
    /**
     * True only on exit 0 with a parseable report whose `ok` is true AND
     * every one of the six contract enrollment items present and ok. The
     * exit code alone is insufficient, and source-only reports (no
     * enrollment array) never validate an enrollment.
     */
    ok: boolean;
    report: SetupCheckReport | null;
    raw: string;
    error?: string;
}

/**
 * Resolve `integrations/setup.ts` inside an installed `@xtrm/substrate`.
 * `XTRM_SUBSTRATE_SETUP` overrides (tests point it at a fixture script).
 * Returns undefined when the package is not installed — callers report,
 * never guess.
 */
/**
 * Resolve the authorized substrate source checkout (contract #174).
 * Explicit `--substrate-dir` flag wins, then `XTRM_SUBSTRATE_DIR` env.
 * Returns the dir + setup.ts without deep validation — `plan --json --dir`
 * validates fail-closed (exit 2) before any mutation. When no explicit
 * source exists, falls back to locating an installed setup.ts (global link
 * or cwd package); `dir` is then undefined and callers must not emit
 * install commands.
 */
export function resolveSubstrateSource(opts: { substrateDir?: string; cwd?: string } = {}): { dir?: string; setupTs?: string; error?: string } {
    const explicit = opts.substrateDir ?? process.env.XTRM_SUBSTRATE_DIR;
    if (explicit) {
        const setupTs = path.join(explicit, 'integrations', 'setup.ts');
        try {
            if (fs.pathExistsSync(setupTs)) return { dir: explicit, setupTs };
        } catch { /* fall through to error */ }
        return { error: `substrate source has no integrations/setup.ts: ${explicit}` };
    }
    const setupTs = resolveSetupTs(opts.cwd);
    if (!setupTs) return { error: 'no substrate source: pass --substrate-dir <checkout> or set XTRM_SUBSTRATE_DIR' };
    return { setupTs };
}

export function resolveSetupTs(cwd?: string): string | undefined {
    // Authority order: explicit XTRM_SUBSTRATE_DIR checkout first, then the
    // XTRM_SUBSTRATE_SETUP file override, then cwd/global search. The dir
    // wins on conflict so enrollment and verification resolve identically.
    const envDir = process.env.XTRM_SUBSTRATE_DIR;
    if (envDir) {
        // Explicit dir is authoritative: absent/unreadable setup.ts fails
        // closed here, never falls through to the override or search.
        let present = false;
        try {
            present = fs.pathExistsSync(path.join(envDir, 'integrations', 'setup.ts'));
        } catch {
            present = false;
        }
        if (!present) return undefined;
        return path.join(envDir, 'integrations', 'setup.ts');
    }
    const override = process.env.XTRM_SUBSTRATE_SETUP;
    if (override) return override;
    const roots: string[] = [];
    if (cwd) roots.push(path.join(cwd, 'node_modules', '@xtrm', 'substrate'));
    try {
        const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
        if (npmRoot.status === 0 && String(npmRoot.stdout ?? '').trim()) {
            roots.push(path.join(String(npmRoot.stdout).trim(), '@xtrm', 'substrate'));
        }
    } catch { /* best-effort */ }
    for (const root of roots) {
        const candidate = path.join(root, 'integrations', 'setup.ts');
        try {
            if (fs.pathExistsSync(candidate)) return candidate;
        } catch { /* next */ }
    }
    return undefined;
}

function canonical(p: string): string | null {
    try {
        return fs.realpathSync(p);
    } catch {
        return null;
    }
}

function runSetupVerb(verb: 'check' | 'plan', opts: { setupTs?: string; cwd?: string; dir?: string } = {}): { status: number | null; stdout: string; stderr: string; error?: string } {
    // An explicit dir pins its own setup.ts (validating existence) so verify
    // can never drift to a different installation than enrollment used. A
    // setupTs that does not belong to the given dir is a fail-closed
    // mismatched pair, never silently honored.
    let setupTs = opts.setupTs;
    if (opts.dir) {
        const candidate = path.join(opts.dir, 'integrations', 'setup.ts');
        if (!fs.pathExistsSync(candidate)) {
            return { status: null, stdout: '', stderr: '', error: `substrate source has no integrations/setup.ts: ${opts.dir}` };
        }
        if (setupTs) {
            const want = canonical(candidate);
            const got = canonical(setupTs);
            if (!want || !got || want !== got) {
                return { status: null, stdout: '', stderr: '', error: `substrate setup.ts does not belong to dir ${opts.dir}` };
            }
        } else {
            setupTs = candidate;
        }
    }
    setupTs ??= resolveSetupTs(opts.cwd);
    if (!setupTs) return { status: null, stdout: '', stderr: '', error: '@xtrm/substrate integrations/setup.ts not installed' };
    // --dir selects the validated checkout (contract #174); without it
    // setup.ts falls back to in-package defaults (the #168 behavior).
    const args = opts.dir ? [setupTs, verb, '--json', '--dir', opts.dir] : [setupTs, verb, '--json'];
    const result = spawnSync('node', args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 60000,
    });
    if (result.error) {
        return { status: result.status, stdout: '', stderr: '', error: (result.error as Error).message };
    }
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

export function runSetupCheck(opts: { setupTs?: string; cwd?: string; dir?: string } = {}): SetupCheckInfo {
    const result = runSetupVerb('check', opts);
    const raw = String(result.stdout ?? '');
    if (result.status !== 0) {
        return { ok: false, report: null, raw, error: (result.error || result.stderr || 'setup.ts check exited non-zero').trim() };
    }
    let report: SetupCheckReport | null = null;
    try {
        report = JSON.parse(raw) as SetupCheckReport;
    } catch {
        return { ok: false, report: null, raw, error: 'setup.ts check emitted unparseable JSON' };
    }
    if (!report || typeof report !== 'object' || report.ok !== true) {
        return { ok: false, report, raw, error: 'setup.ts check reported unhealthy integrations' };
    }
    // Exact contract shape: the enrollment array must exist and contain
    // exactly the six unique expected names, every one ok. Duplicates,
    // extras, or a missing array never validate an enrollment.
    if (!Array.isArray(report.enrollment)) {
        return { ok: false, report, raw, error: 'setup.ts check has no enrollment contract' };
    }
    const enrollment = report.enrollment;
    const seen = new Set<string>();
    for (const entry of enrollment) {
        if (!entry || typeof entry.name !== 'string' || !EXPECTED_ENROLLMENT_ITEMS.includes(entry.name as (typeof EXPECTED_ENROLLMENT_ITEMS)[number])
            || entry.ok !== true || seen.has(entry.name)) {
            return { ok: false, report, raw, error: `setup.ts enrollment rejected on item: ${entry?.name ?? '?'}` };
        }
        seen.add(entry.name);
    }
    const missing = EXPECTED_ENROLLMENT_ITEMS.filter(name => !seen.has(name));
    if (missing.length > 0) {
        return { ok: false, report, raw, error: `setup.ts enrollment incomplete, missing: ${missing.join(', ')}` };
    }
    return { ok: true, report, raw };
}

export interface SetupPlanSurface {
    surface: string;
    source: string;
    target: string;
    steps: string[];
}

export function runSetupPlan(opts: { setupTs?: string; cwd?: string; dir?: string } = {}): { ok: boolean; surfaces: SetupPlanSurface[]; dir: string | null; commands: PlannedCommand[]; raw: string; error?: string } {
    const result = runSetupVerb('plan', opts);
    const raw = String(result.stdout ?? '');
    if (result.status !== 0) {
        return { ok: false, surfaces: [], dir: null, commands: [], raw, error: (result.error || result.stderr || 'setup.ts plan exited non-zero').trim() };
    }
    try {
        const plan = JSON.parse(raw) as { surfaces?: SetupPlanSurface[]; dir?: string; commands?: PlannedCommand[] };
        if (!plan || !Array.isArray(plan.surfaces)) return { ok: false, surfaces: [], dir: null, commands: [], raw, error: 'setup.ts plan emitted an unexpected shape' };
        // Fail-closed plan acceptance: a plan without a canonical dir or
        // with zero commands is not executable — old source-only reports
        // must never validate an enrollment.
        if (typeof plan.dir !== 'string' || !plan.dir) {
            return { ok: false, surfaces: plan.surfaces, dir: null, commands: [], raw, error: 'setup.ts plan has no canonical dir' };
        }
        if (!Array.isArray(plan.commands) || plan.commands.length === 0) {
            return { ok: false, surfaces: plan.surfaces, dir: plan.dir, commands: [], raw, error: 'setup.ts plan has no commands' };
        }
        return { ok: true, surfaces: plan.surfaces, dir: plan.dir, commands: plan.commands, raw };
    } catch {
        return { ok: false, surfaces: [], raw, error: 'setup.ts plan emitted unparseable JSON', dir: null, commands: [] };
    }
}

/** Validate every plan command BEFORE executing command 1: a malformed
 * entry anywhere aborts with zero executions (no partial mutation). */
export function validatePlanCommands(commands: PlannedCommand[]): string | null {
    if (!Array.isArray(commands)) return 'plan commands are not an array';
    for (const [index, command] of commands.entries()) {
        if (!command || typeof command.cmd !== 'string' || !command.cmd.trim()
            || !Array.isArray(command.args) || !command.args.every(a => typeof a === 'string')
            || typeof command.label !== 'string' || !command.label.trim()) {
            return `plan command ${index} is malformed`;
        }
    }
    return null;
}

export interface PlannedCommand {
    label: string;
    cmd: string;
    args: string[];
}

export interface PlanCommandResult {
    label: string;
    cmd: string;
    args: string[];
    status: number | null;
    stdout: string;
    stderr: string;
    ok: boolean;
    error?: string;
}

function planCommandTimeout(cmd: string, args: string[]): number {
    // Per-producer guidance: source install up to 10 minutes, rest 60-120s.
    if (cmd === 'npm' && args.includes('ci')) return 600000;
    return 120000;
}

function truncateLines(text: string, maxLines: number): string {
    const lines = text.split('\n');
    if (lines.length <= maxLines) return text;
    return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines truncated)`;
}

/**
 * Execute validated plan commands verbatim as argv (never shell:true), in
 * emitted order, aborting on the first nonzero exit. Diagnostics carry
 * truncated head output only (versions/counts/names).
 */
export function executePlanCommands(
    commands: PlannedCommand[],
    opts: { cwd?: string; run?: (cmd: string, args: string[], timeout: number) => { status: number | null; stdout: string; stderr: string; error?: string } } = {},
): { ok: boolean; results: PlanCommandResult[]; failedLabel?: string } {
    const results: PlanCommandResult[] = [];
    const run = opts.run ?? ((cmd: string, args: string[], timeout: number) => {
        const result = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: 'pipe', timeout });
        if (result.error) {
            return { status: result.status, stdout: '', stderr: '', error: (result.error as Error).message };
        }
        return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    });
    // Whole-plan validation first: zero executions when any entry is bad.
    const malformed = validatePlanCommands(commands);
    if (malformed) {
        results.push({ label: '(plan validation)', cmd: '', args: [], status: null, stdout: '', stderr: '', ok: false, error: malformed });
        return { ok: false, results, failedLabel: '(plan validation)' };
    }
    for (const command of commands) {
        const result = run(command.cmd, command.args, planCommandTimeout(command.cmd, command.args));
        const ok = result.status === 0;
        results.push({
            label: command.label,
            cmd: command.cmd,
            args: command.args,
            status: result.status,
            stdout: truncateLines(String(result.stdout ?? ''), 20),
            stderr: truncateLines(String(result.stderr ?? ''), 20),
            ok,
            error: ok ? undefined : (result.error || result.stderr || `exited ${result.status}`).trim().slice(0, 500),
        });
        if (!ok) return { ok: false, results, failedLabel: command.label };
    }
    return { ok: true, results };
}
