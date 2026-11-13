/**
 * Operator-side Claude Code route selection — the `claude_bridge` block in the
 * specialists user config (CORE-2632, Option A of SPECIALISTS-4442).
 *
 * The route has exactly one operator-side switch: `claude_bridge` in
 * `~/.config/specialists/user.json` (or the XDG/legacy equivalents). The
 * Specialists loader owns route *resolution*; this module only reads and writes
 * the block that drives it, and it mirrors that loader's schema rules so a write
 * through `xt claude-route` is a write the loader accepts:
 *
 *   - `enabled`                        machine consent (default false)
 *   - `default_model`                  `claude-bridge/...` only
 *   - `specialists`                    explicit kebab-case allow list, no wildcard
 *   - `models`                         per-listed-name `claude-bridge/...` model
 *
 * Provenance: grammar mirrored from `@jaggerxtrm/specialists`
 * `src/specialist/global-config.ts` as merged for SPECIALISTS-4442
 * (xtrm-dev/specialists@36b89e24). `tests/claude-route-schema-pin.test.ts` pins
 * the two copies; refresh it when the specialists schema changes.
 *
 * Safety properties this module guarantees:
 *   - the operator's file is the ONLY file written; no per-Specialist copy;
 *   - a malformed or non-object existing file is never overwritten — the write
 *     refuses with the parse error instead of replacing operator content;
 *   - the write targets the file the Specialists loader would already read
 *     (XDG, then `~/.config`, then legacy `~/.specialists`), so writing the
 *     route can never shadow a file that is currently in effect;
 *   - atomic write (sibling temp file + rename);
 *   - `disable` records `enabled: false` rather than deleting the block, because
 *     an absent block restores the legacy per-definition flag and could silently
 *     re-enable billing; `--purge` removes the key when the operator insists.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** Reserved top-level key in the specialists user config. */
export const CLAUDE_ROUTE_BLOCK_KEY = 'claude_bridge';
/** The provider prefix every selectable bridge model must carry. */
export const CLAUDE_ROUTE_MODEL_PREFIX = 'claude-bridge/';
/**
 * Specialist-name grammar: kebab-case only. Admits no wildcard, no glob, no
 * path and no empty string, so consent always names one Specialist.
 */
export const CLAUDE_ROUTE_SPECIALIST_NAME_PATTERN_SOURCE = '^[a-z][a-z0-9-]*$';
export const CLAUDE_ROUTE_SPECIALIST_NAME_PATTERN = new RegExp(CLAUDE_ROUTE_SPECIALIST_NAME_PATTERN_SOURCE);
/** The complete, closed key set of the block (`strict()` on the schema). */
export const CLAUDE_ROUTE_BLOCK_KEYS = ['enabled', 'default_model', 'specialists', 'models'] as const;

const CLAUDE_ROUTE_SUBDIR = 'specialists';
const CLAUDE_ROUTE_CONFIG_FILENAME = 'user.json';

export const ClaudeRouteSpecialistNameSchema = z
    .string()
    .regex(CLAUDE_ROUTE_SPECIALIST_NAME_PATTERN, 'must be an explicit kebab-case Specialist name (no wildcard, no glob)');

export const ClaudeRouteModelSchema = z
    .string()
    .refine(
        value => value.startsWith(CLAUDE_ROUTE_MODEL_PREFIX) && value.length > CLAUDE_ROUTE_MODEL_PREFIX.length,
        { message: `must be a ${CLAUDE_ROUTE_MODEL_PREFIX}... model` },
    );

export const ClaudeRouteBlockSchema = z
    .object({
        enabled: z.boolean().default(false),
        default_model: ClaudeRouteModelSchema.optional(),
        specialists: z.array(ClaudeRouteSpecialistNameSchema).optional(),
        models: z.record(z.string(), ClaudeRouteModelSchema).optional(),
    })
    .strict()
    .superRefine((block, ctx) => {
        if (!block.specialists) return;
        for (const name of block.specialists) {
            const model = block.models?.[name] ?? block.default_model;
            if (model === undefined) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['specialists'],
                    message:
                        `listed Specialist "${name}" has no bridge model: set models.${name} or default_model ` +
                        `(${CLAUDE_ROUTE_MODEL_PREFIX}...)`,
                });
            }
        }
    });

export type ClaudeRouteBlock = z.infer<typeof ClaudeRouteBlockSchema>;

/** Where the Specialists loader would read the operator config from. */
export interface ClaudeRouteConfigLocation {
    path: string;
    exists: boolean;
    /** Same precedence the Specialists loader applies. */
    source: 'xdg' | 'config-home' | 'legacy';
}

/**
 * Resolve the operator config path exactly as `@jaggerxtrm/specialists` does:
 * `XDG_CONFIG_HOME` wins when set, then an existing `~/.config` file, then an
 * existing legacy `~/.specialists` file, then the canonical `~/.config` path.
 * Writing anywhere else would shadow the file already in effect.
 */
export function resolveClaudeRouteConfigLocation(
    env: NodeJS.ProcessEnv = process.env,
    homeDir: string = env.HOME?.trim() || homedir(),
    exists: (candidate: string) => boolean = existsSync,
): ClaudeRouteConfigLocation {
    const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
    if (xdgConfigHome) {
        const xdgPath = path.join(xdgConfigHome, CLAUDE_ROUTE_SUBDIR, CLAUDE_ROUTE_CONFIG_FILENAME);
        return { path: xdgPath, exists: exists(xdgPath), source: 'xdg' };
    }

    const configHomePath = path.join(homeDir, '.config', CLAUDE_ROUTE_SUBDIR, CLAUDE_ROUTE_CONFIG_FILENAME);
    if (exists(configHomePath)) return { path: configHomePath, exists: true, source: 'config-home' };

    const legacyPath = path.join(homeDir, '.specialists', CLAUDE_ROUTE_CONFIG_FILENAME);
    if (exists(legacyPath)) return { path: legacyPath, exists: true, source: 'legacy' };

    return { path: configHomePath, exists: false, source: 'config-home' };
}

export interface ClaudeRouteBlockRead {
    /** The file holds a `claude_bridge` key at all. */
    present: boolean;
    /** The validated block, or null when absent or invalid. */
    block: ClaudeRouteBlock | null;
    /** Structured reason the block could not be used; null when absent or valid. */
    error: string | null;
    /** Names the raw block appears to list, even when it fails validation. */
    listedNames: string[];
    /** Absolute path of the file that was read. */
    path: string;
    source: ClaudeRouteConfigLocation['source'];
}

function rawListedNames(raw: unknown): string[] {
    if (typeof raw !== 'object' || raw === null) return [];
    const specialists = (raw as Record<string, unknown>).specialists;
    if (!Array.isArray(specialists)) return [];
    return specialists.filter((name): name is string => typeof name === 'string');
}

function formatIssues(error: z.ZodError): string {
    return error.issues
        .map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
        .join('; ');
}

/**
 * Read and validate the block. Never throws: a missing file, malformed JSON and
 * an invalid block each produce a structured result, so the writer, the CLI and
 * `xt doctor` all observe the same failure.
 */
export function readClaudeRouteBlock(
    location: ClaudeRouteConfigLocation = resolveClaudeRouteConfigLocation(),
    readFile: (candidate: string) => string = candidate => readFileSync(candidate, 'utf-8'),
): ClaudeRouteBlockRead {
    const absent: ClaudeRouteBlockRead = {
        present: false,
        block: null,
        error: null,
        listedNames: [],
        path: location.path,
        source: location.source,
    };
    if (!location.exists) return absent;

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFile(location.path));
    } catch (error) {
        return { ...absent, present: true, error: `user.json is not valid JSON: ${(error as Error).message}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ...absent, present: true, error: 'user.json is not a JSON object' };
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, CLAUDE_ROUTE_BLOCK_KEY)) return absent;

    const rawBlock = (parsed as Record<string, unknown>)[CLAUDE_ROUTE_BLOCK_KEY];
    const listedNames = rawListedNames(rawBlock);
    const result = ClaudeRouteBlockSchema.safeParse(rawBlock);
    if (!result.success) {
        return {
            ...absent,
            present: true,
            error: `invalid ${CLAUDE_ROUTE_BLOCK_KEY} block: ${formatIssues(result.error)}`,
            listedNames,
        };
    }
    return { ...absent, present: true, block: result.data, listedNames };
}

export type ClaudeRouteValidation =
    | { ok: true; block: ClaudeRouteBlock }
    | { ok: false; error: string };

/** Validate a candidate block against the mirrored schema. */
export function validateClaudeRouteBlock(input: unknown): ClaudeRouteValidation {
    const result = ClaudeRouteBlockSchema.safeParse(input);
    return result.success ? { ok: true, block: result.data } : { ok: false, error: formatIssues(result.error) };
}

/** Input the CLI collects from flags before consent. */
export interface ClaudeRouteEnableInput {
    specialists: readonly string[];
    /** Model applied to every listed Specialist. */
    model: string;
    /** Optional machine-wide default; defaults to `model`. */
    defaultModel?: string;
}

/**
 * Build the block an `enable` writes: the allow list is the explicit set the
 * operator named (deduplicated, order preserved), every name maps to a bridged
 * model, and no wildcard can appear because the name schema rejects it.
 */
export function buildClaudeRouteBlock(input: ClaudeRouteEnableInput): ClaudeRouteValidation {
    const specialists = [...new Set(input.specialists.map(name => name.trim()).filter(name => name.length > 0))];
    const models: Record<string, string> = {};
    for (const name of specialists) models[name] = input.model.trim();
    const candidate = {
        enabled: true,
        default_model: (input.defaultModel ?? input.model).trim(),
        specialists,
        models,
    };
    return validateClaudeRouteBlock(candidate);
}

export interface ClaudeRouteWriteResult {
    path: string;
    source: ClaudeRouteConfigLocation['source'];
    block: ClaudeRouteBlock;
    write: WriteOutcome;
}

type UserConfigRecord = Record<string, unknown>;

/**
 * Read the whole config object for a merge-in-place write. A missing file is an
 * empty object; a malformed or non-object file is an error the caller must
 * surface — never a file this module overwrites.
 */
function readUserConfigForWrite(
    location: ClaudeRouteConfigLocation,
    readFile: (candidate: string) => string,
): { ok: true; config: UserConfigRecord } | { ok: false; error: string } {
    if (!location.exists) return { ok: true, config: {} };
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFile(location.path));
    } catch (error) {
        return { ok: false, error: `refusing to overwrite malformed ${location.path}: ${(error as Error).message}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: `refusing to overwrite ${location.path}: not a JSON object` };
    }
    return { ok: true, config: parsed as UserConfigRecord };
}

export interface WriteOutcome {
    /** The rename landed atomically. */
    atomic: boolean;
    /** Why atomicity was not achievable; null when it was. */
    fallbackError: string | null;
}

export type ClaudeRouteConfigWriter = (location: ClaudeRouteConfigLocation, config: UserConfigRecord) => WriteOutcome;

/**
 * Atomic write: sibling temp file in the same directory, then rename.
 *
 * A failed rename (EXDEV/EBUSY on a container or network home) still writes the
 * destination directly, because leaving the operator without the switch is worse
 * than a non-atomic write. The degraded write is REPORTED, never thrown: the
 * config did change, and turning that into a command failure would report a
 * success as an error.
 */
function writeUserConfig(location: ClaudeRouteConfigLocation, config: UserConfigRecord): WriteOutcome {
    mkdirSync(path.dirname(location.path), { recursive: true });
    const payload = `${JSON.stringify(config, null, 2)}\n`;
    const tmpPath = `${location.path}.tmp.${process.pid}.${Math.floor(performance.now() * 1000)}`;

    // A failed temp write never reached a rename: it is a plain write failure and
    // the destination is untouched, so it propagates as one.
    try {
        writeFileSync(tmpPath, payload, 'utf-8');
    } catch (writeError) {
        try { rmSync(tmpPath, { force: true }); } catch { /* cleanup must not mask the error */ }
        throw new Error(`cannot write ${tmpPath}: ${(writeError as Error).message}`);
    }

    try {
        renameSync(tmpPath, location.path);
        return { atomic: true, fallbackError: null };
    } catch (renameError) {
        try { rmSync(tmpPath, { force: true }); } catch { /* cleanup must not mask the error */ }
        try {
            writeFileSync(location.path, payload, 'utf-8');
        } catch (fallbackError) {
            // The direct write truncates before it writes, so a failure here can
            // leave the file unparseable. That must surface as a failure, with the
            // remedy, not as a warning.
            throw new Error(
                `rename failed (${(renameError as Error).message}) and the direct write of ${location.path} failed too ` +
                `(${(fallbackError as Error).message}); the file may be truncated — repair it by hand`,
            );
        }
        return { atomic: false, fallbackError: `rename failed: ${(renameError as Error).message}` };
    }
}

/**
 * Write a validated block into the operator's user config, preserving every
 * other top-level key (legacy Specialist overrides stay untouched).
 */
export function writeClaudeRouteBlock(
    input: unknown,
    location: ClaudeRouteConfigLocation = resolveClaudeRouteConfigLocation(),
    deps: { readFile?: (candidate: string) => string; write?: ClaudeRouteConfigWriter } = {},
): { ok: true; result: ClaudeRouteWriteResult } | { ok: false; error: string } {
    const validation = validateClaudeRouteBlock(input);
    if (!validation.ok) return { ok: false, error: validation.error };

    const readFile = deps.readFile ?? ((candidate: string) => readFileSync(candidate, 'utf-8'));
    const existing = readUserConfigForWrite(location, readFile);
    if (!existing.ok) return existing;

    const config: UserConfigRecord = { ...existing.config, [CLAUDE_ROUTE_BLOCK_KEY]: validation.block };
    const write = (deps.write ?? writeUserConfig)(location, config);
    return { ok: true, result: { path: location.path, source: location.source, block: validation.block, write } };
}

export type ClaudeRouteDisableOutcome = 'disabled' | 'purged' | 'absent';

/**
 * Turn the route off. Default is `enabled: false` with the allow list kept —
 * deleting the key would restore the legacy per-definition flag behaviour and
 * could silently route Specialist work back to a billable Claude subscription.
 * `purge` removes the key outright for an operator who wants the file clean.
 */
export function disableClaudeRoute(
    location: ClaudeRouteConfigLocation = resolveClaudeRouteConfigLocation(),
    deps: { purge?: boolean; readFile?: (candidate: string) => string; write?: ClaudeRouteConfigWriter } = {},
): { ok: true; path: string; source: ClaudeRouteConfigLocation['source']; outcome: ClaudeRouteDisableOutcome; write: WriteOutcome | null } | { ok: false; error: string } {
    const readFile = deps.readFile ?? ((candidate: string) => readFileSync(candidate, 'utf-8'));
    const existing = readUserConfigForWrite(location, readFile);
    if (!existing.ok) return existing;

    const hasBlock = Object.prototype.hasOwnProperty.call(existing.config, CLAUDE_ROUTE_BLOCK_KEY);
    if (!hasBlock) {
        return { ok: true, path: location.path, source: location.source, outcome: 'absent', write: null };
    }

    const write = deps.write ?? writeUserConfig;
    const config: UserConfigRecord = { ...existing.config };
    if (deps.purge) {
        delete config[CLAUDE_ROUTE_BLOCK_KEY];
        return { ok: true, path: location.path, source: location.source, outcome: 'purged', write: write(location, config) };
    }

    // A block this command cannot validate cannot be switched off by editing one
    // field of it: `{enabled:false, specialists:["*"]}` is still invalid, so the
    // loader and `xt doctor` keep reporting the same error. Rewriting it would
    // destroy a block core cannot read — and core's schema is a mirror, so a
    // specialists change could make a valid operator block look invalid here.
    // Removal therefore needs the operator's explicit --purge.
    const current = config[CLAUDE_ROUTE_BLOCK_KEY];
    const valid = validateClaudeRouteBlock(current);
    if (!valid.ok) {
        return {
            ok: false,
            error:
                `the existing ${CLAUDE_ROUTE_BLOCK_KEY} block does not validate (${valid.error}), so editing it cannot clear the ` +
                `state; run \`xt claude-route disable --purge\` to remove it, or repair it by hand`,
        };
    }

    config[CLAUDE_ROUTE_BLOCK_KEY] = { ...(current as UserConfigRecord), enabled: false };
    return { ok: true, path: location.path, source: location.source, outcome: 'disabled', write: write(location, config) };
}

export interface ClaudeRouteStatus {
    path: string;
    source: ClaudeRouteConfigLocation['source'];
    enabled: boolean;
    /** Names the block lists, in file order; empty when the block is absent/invalid. */
    listedSpecialists: string[];
    /** Model each listed Specialist resolves to, when the block is valid. */
    models: Record<string, string>;
    /** Structured reason the block could not be used. */
    error: string | null;
    present: boolean;
}

/** Read-only projection for `xt claude-route status` and `xt doctor`. */
export function getClaudeRouteStatus(
    location: ClaudeRouteConfigLocation = resolveClaudeRouteConfigLocation(),
    read: (candidate: ClaudeRouteConfigLocation) => ClaudeRouteBlockRead = candidate => readClaudeRouteBlock(candidate),
): ClaudeRouteStatus {
    const readResult = read(location);
    const block = readResult.block;
    const models: Record<string, string> = {};
    for (const name of block?.specialists ?? []) {
        const model = block?.models?.[name] ?? block?.default_model;
        if (model) models[name] = model;
    }
    return {
        path: readResult.path,
        source: readResult.source,
        enabled: block?.enabled === true,
        listedSpecialists: block?.specialists ?? [],
        models,
        error: readResult.error,
        present: readResult.present,
    };
}

/**
 * Names the installed Specialists CLI knows, for a typo warning on `enable`.
 *
 * Advisory only: a name may legitimately be defined in a layer this lookup does
 * not see, so an unknown name is a warning, never a refusal. Null means the
 * lookup was unavailable and no claim can be made either way.
 */
export function resolveKnownSpecialistNames(
    run: (command: string, args: string[]) => { status: number | null; stdout: string } = (command, args) => {
        const result = spawnSync(command, args, { encoding: 'utf-8', timeout: 5000 });
        return { status: result.status, stdout: result.stdout ?? '' };
    },
): Set<string> | null {
    const result = run('sp', ['list', '--json']);
    if (result.status !== 0) return null;
    try {
        const parsed: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(parsed)) return null;
        const names = parsed
            .map(entry => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined))
            .filter((name): name is string => typeof name === 'string' && name.length > 0);
        return names.length > 0 ? new Set(names) : null;
    } catch {
        return null;
    }
}
