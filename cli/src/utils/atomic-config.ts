import { randomUUID } from 'node:crypto';
import fs from 'fs-extra';
// @ts-ignore
import { parse, stringify } from 'comment-json';

/**
 * Atomic Configuration Handler with Vault Pattern
 * Ensures safe read/write operations with protection against corruption during crashes
 */

// Protected keys that should never be overwritten if they exist locally
const PROTECTED_KEYS = [
    'permissions.allow',       // User-defined permissions
    'hooks.UserPromptSubmit',  // Claude hooks
    'hooks.SessionStart',
    'hooks.PreToolUse',
    'hooks.BeforeAgent',       // Gemini hooks
    'hooks.BeforeTool',        // Gemini hooks
    'security',                // Auth secrets/OAuth data
    'general',                 // Personal preferences
    'enabledPlugins',          // User-enabled/disabled plugins
    'model',                   // User's preferred model
    'skillSuggestions.enabled' // User preferences
];

/**
 * Check if a key path is exactly protected or a parent of a protected key
 */
export function isProtectedPath(keyPath: string): boolean {
    return PROTECTED_KEYS.some(protectedPath =>
        keyPath === protectedPath || protectedPath.startsWith(keyPath + '.')
    );
}

/**
 * Check if a key path is a protected key or a child of a protected key
 */
export function isValueProtected(keyPath: string): boolean {
    return PROTECTED_KEYS.some(protectedPath =>
        keyPath === protectedPath || keyPath.startsWith(protectedPath + '.')
    );
}

function extractHookCommands(wrapper: any): string[] {
    if (!wrapper || !Array.isArray(wrapper.hooks)) return [];
    return wrapper.hooks
        .map((h: any) => h?.command)
        .filter((c: any): c is string => typeof c === 'string' && c.trim().length > 0);
}

function commandKey(command: string): string {
    const m = command.match(/([A-Za-z0-9._-]+\.(?:py|cjs|mjs|js))(?!.*[A-Za-z0-9._-]+\.(?:py|cjs|mjs|js))/);
    return m?.[1] || command.trim();
}

/**
 * Extract script filename from a hook command for pruning purposes.
 */
function scriptKey(command: string): string | null {
    // Match the script path relative to hooks directory
    // Pattern: /hooks/<optional-subdir>/<filename>.<ext>
    const m = command.match(/\/hooks\/([A-Za-z0-9_/-]+\.(?:py|cjs|mjs|js))/);
    if (m) return m[1];

    // Fallback: match just the filename if no /hooks/ path
    const m2 = command.match(/([A-Za-z0-9_-]+\.(?:py|cjs|mjs|js))(?!.*[A-Za-z0-9._-]+\.(?:py|cjs|mjs|js))/);
    return m2?.[1] || null;
}

/**
 * Collect all canonical script filenames from incoming hooks.
 */
function collectCanonicalScripts(incomingHooks: any): Set<string> {
    const scripts = new Set<string>();
    if (!incomingHooks || typeof incomingHooks !== 'object') return scripts;

    for (const wrappers of Object.values(incomingHooks)) {
        if (!Array.isArray(wrappers)) continue;
        for (const wrapper of wrappers) {
            const commands = extractHookCommands(wrapper);
            for (const cmd of commands) {
                const script = scriptKey(cmd);
                if (script) scripts.add(script);
            }
        }
    }
    return scripts;
}

/**
 * Prune existing hook wrappers that reference scripts NOT in canonical set.
 * Returns { pruned: wrappers[], removed: string[] }
 */
function pruneStaleWrappers(existing: any[], canonicalScripts: Set<string>): { pruned: any[]; removed: string[] } {
    if (canonicalScripts.size === 0) {
        return { pruned: existing, removed: [] };
    }

    const removed: string[] = [];
    const pruned: any[] = [];

    for (const wrapper of existing) {
        if (!Array.isArray(wrapper.hooks)) {
            pruned.push(wrapper);
            continue;
        }

        const keptHooks: any[] = [];
        for (const hook of wrapper.hooks) {
            const cmd = hook?.command;
            if (typeof cmd !== 'string') {
                keptHooks.push(hook);
                continue;
            }
            // Only prune hooks that are clearly xtrm-managed (have /hooks/ in their path)
            // User-local hooks from other directories are always preserved
            const isXtrmManaged = /\/hooks\//.test(cmd);
            if (!isXtrmManaged) {
                keptHooks.push(hook);
                continue;
            }
            const script = scriptKey(cmd);
            // Keep if: no script (not a file-based hook) OR script is in canonical set
            if (!script || canonicalScripts.has(script)) {
                keptHooks.push(hook);
            } else {
                removed.push(script);
            }
        }

        if (keptHooks.length > 0) {
            pruned.push({ ...wrapper, hooks: keptHooks });
        }
    }

    return { pruned, removed };
}

function mergeMatcher(existingMatcher: string, incomingMatcher: string): string {
    const parts = [
        ...existingMatcher.split('|').map((s: string) => s.trim()),
        ...incomingMatcher.split('|').map((s: string) => s.trim()),
    ].filter(Boolean);
    return Array.from(new Set(parts)).join('|');
}

function mergeHookWrappers(existing: any[], incoming: any[]): any[] {
    const merged = existing.map((w: any) => ({ ...w }));

    for (const incomingWrapper of incoming) {
        const incomingCommands = extractHookCommands(incomingWrapper);
        if (incomingCommands.length === 0) {
            merged.push(incomingWrapper);
            continue;
        }

        const incomingKeys = new Set(incomingCommands.map(commandKey));
        const incomingTokens = new Set(
            typeof incomingWrapper.matcher === 'string'
                ? incomingWrapper.matcher.split('|').map((s: string) => s.trim()).filter(Boolean)
                : [],
        );

        const existingIndex = merged.findIndex((existingWrapper: any) => {
            const existingCommands = extractHookCommands(existingWrapper);
            if (!existingCommands.some((c: string) => incomingKeys.has(commandKey(c)))) return false;

            // Only merge with entries whose matchers overlap (share at least one token).
            // Disjoint matchers (e.g. "Write|Edit" vs "Bash") intentionally serve
            // different purposes and must remain as separate entries.
            if (
                typeof existingWrapper.matcher === 'string' &&
                typeof incomingWrapper.matcher === 'string' &&
                incomingTokens.size > 0
            ) {
                const existingTokens = existingWrapper.matcher
                    .split('|').map((s: string) => s.trim()).filter(Boolean);
                const hasOverlap = existingTokens.some((t: string) => incomingTokens.has(t));
                if (!hasOverlap) return false;
            }

            return true;
        });

        if (existingIndex === -1) {
            merged.push(incomingWrapper);
            continue;
        }

        const existingWrapper = merged[existingIndex];
        if (
            typeof existingWrapper.matcher === 'string' &&
            typeof incomingWrapper.matcher === 'string'
        ) {
            existingWrapper.matcher = mergeMatcher(existingWrapper.matcher, incomingWrapper.matcher);
        }

        if (Array.isArray(existingWrapper.hooks) && Array.isArray(incomingWrapper.hooks)) {
            const existingByKey = new Set(existingWrapper.hooks
                .map((h: any) => h?.command)
                .filter((c: any): c is string => typeof c === 'string')
                .map(commandKey));
            for (const hook of incomingWrapper.hooks) {
                const cmd = hook?.command;
                if (typeof cmd !== 'string' || !existingByKey.has(commandKey(cmd))) {
                    existingWrapper.hooks.push(hook);
                }
            }
        }
    }

    return merged;
}

/**
 * Prune mode: replace xtrm-managed wrappers wholesale with canonical ones.
 * Wrappers whose commands do NOT reference ~/.claude/hooks/ (user-local) are always preserved.
 */
function replaceHooksObject(existingHooks: any, incomingHooks: any): any {
    const result: any = {};
    const canonicalScripts = collectCanonicalScripts(incomingHooks);

    // Events only in existing: prune xtrm-managed entries, keep user-local
    for (const [event, existingWrappers] of Object.entries(existingHooks || {})) {
        if (!Array.isArray(existingWrappers)) { result[event] = existingWrappers; continue; }
        if (event in (incomingHooks || {})) continue; // handled below
        const { pruned } = pruneStaleWrappers(existingWrappers, canonicalScripts);
        if (pruned.length > 0) result[event] = pruned;
    }

    // Events in incoming: use canonical wrappers + preserve user-local wrappers
    for (const [event, incomingWrappers] of Object.entries(incomingHooks || {})) {
        const existingWrappers: any[] = Array.isArray(existingHooks?.[event]) ? existingHooks[event] : [];
        const userLocal = existingWrappers.filter((wrapper: any) => {
            if (!Array.isArray(wrapper.hooks)) return true;
            return wrapper.hooks.every((h: any) => {
                const cmd = h?.command;
                return typeof cmd !== 'string' || !/\/hooks\//.test(cmd);
            });
        });
        result[event] = [...(Array.isArray(incomingWrappers) ? incomingWrappers : []), ...userLocal];
    }

    return result;
}

function mergeHooksObject(existingHooks: any, incomingHooks: any): any {
    // Step 1: Collect canonical script filenames from incoming hooks
    const canonicalScripts = collectCanonicalScripts(incomingHooks);

    // Step 2: Prune existing hooks that reference non-canonical scripts
    const result: any = {};
    for (const [event, existingWrappers] of Object.entries(existingHooks || {})) {
        if (!Array.isArray(existingWrappers)) {
            result[event] = existingWrappers;
            continue;
        }
        const { pruned } = pruneStaleWrappers(existingWrappers, canonicalScripts);
        if (pruned.length > 0) {
            result[event] = pruned;
        }
    }

    // Step 3: Merge incoming hooks with pruned existing hooks
    for (const [event, incomingWrappers] of Object.entries(incomingHooks || {})) {
        const existingWrappers = Array.isArray(result[event]) ? result[event] : [];
        const incomingArray = Array.isArray(incomingWrappers) ? incomingWrappers : [];
        result[event] = mergeHookWrappers(existingWrappers, incomingArray);
    }
    return result;
}

/**
 * Deep merge two objects, preserving protected values from the original
 */
export function deepMergeWithProtection(original: any, updates: any, currentPath: string = '', opts: { pruneHooks?: boolean } = {}): any {
    const result = { ...original };

    for (const [key, value] of Object.entries(updates)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const keyPath = currentPath ? `${currentPath}.${key}` : key;

        // Hooks: merge by command identity normally; in prune mode replace xtrm-managed wrappers wholesale.
        if (
            key === 'hooks' &&
            typeof value === 'object' &&
            value !== null &&
            typeof original[key] === 'object' &&
            original[key] !== null
        ) {
            result[key] = opts.pruneHooks
                ? replaceHooksObject(original[key], value)
                : mergeHooksObject(original[key], value);
            continue;
        }

        // If this specific value is protected and exists locally, skip it
        if (isValueProtected(keyPath) && original.hasOwnProperty(key)) {
            continue;
        }

        // Special handling for mcpServers: merge individual server entries
        if (key === 'mcpServers' && typeof value === 'object' && value !== null &&
            typeof original[key] === 'object' && original[key] !== null) {

            result[key] = { ...original[key] }; // Start with original servers

            // Add servers from updates that don't exist in original
            for (const [serverName, serverConfig] of Object.entries(value)) {
                if (!result[key].hasOwnProperty(serverName)) {
                    result[key][serverName] = serverConfig;
                }
            }
        } else if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            typeof original[key] === 'object' &&
            original[key] !== null &&
            !Array.isArray(original[key])
        ) {
            // Recursively merge nested objects
            result[key] = deepMergeWithProtection(original[key], value, keyPath, opts);
        } else {
            // Overwrite with new value for non-protected keys
            result[key] = value;
        }
    }

    return result;
}

interface AtomicWriteOptions {
    preserveComments?: boolean;
    backupOnSuccess?: boolean;
    backupSuffix?: string;
}

/**
 * Atomically write data to a file using a temporary file
 */
export async function atomicWrite(filePath: string, data: any, options: AtomicWriteOptions = {}): Promise<void> {
    const {
        preserveComments = false,
        backupOnSuccess = false,
        backupSuffix = '.bak'
    } = options;

    const tempFilePath = `${filePath}.tmp.${randomUUID()}`;

    try {
        let content: string;
        if (preserveComments) {
            content = stringify(data, null, 2);
        } else {
            content = JSON.stringify(data, null, 2);
        }

        await fs.writeFile(tempFilePath, content, 'utf8');

        const tempStats = await fs.stat(tempFilePath);
        if (tempStats.size === 0) {
            throw new Error('Temporary file is empty - write failed');
        }

        if (backupOnSuccess && await fs.pathExists(filePath)) {
            const backupPath = `${filePath}${backupSuffix}`;
            await fs.copy(filePath, backupPath);
        }

        await fs.rename(tempFilePath, filePath);
    } catch (error) {
        try {
            if (await fs.pathExists(tempFilePath)) {
                await fs.unlink(tempFilePath);
            }
        } catch (cleanupError) { }
        throw error;
    }
}

/**
 * Safely read a JSON configuration file with error handling
 */
export async function safeReadConfig(filePath: string): Promise<any> {
    try {
        if (!(await fs.pathExists(filePath))) {
            return {};
        }

        const content = await fs.readFile(filePath, 'utf8');

        try {
            return parse(content);
        } catch (parseError) {
            return JSON.parse(content);
        }
    } catch (error: any) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`Failed to read config file: ${error.message}`);
    }
}

interface MergeOptions {
    preserveComments?: boolean;
    backupOnSuccess?: boolean;
    dryRun?: boolean;
    resolvedLocalConfig?: any;
    pruneHooks?: boolean;
}

export interface MergeResult {
    updated: boolean;
    changes: string[];
}

/**
 * Perform a safe merge of repository config with local config
 */
export async function safeMergeConfig(localConfigPath: string, repoConfig: any, options: MergeOptions = {}): Promise<MergeResult> {
    const {
        preserveComments = true,
        backupOnSuccess = true,
        dryRun = false,
        resolvedLocalConfig = null,
        pruneHooks = false,
    } = options;

    const localConfig = resolvedLocalConfig || await safeReadConfig(localConfigPath);
    const changes: string[] = [];

    if (localConfig.mcpServers && typeof localConfig.mcpServers === 'object') {
        const localServerNames = Object.keys(localConfig.mcpServers);
        if (localServerNames.length > 0) {
            changes.push(`Preserved ${localServerNames.length} local mcpServers: ${localServerNames.join(', ')}`);
        }
    }

    if (repoConfig.mcpServers && typeof repoConfig.mcpServers === 'object') {
        const repoServerNames = Object.keys(repoConfig.mcpServers);
        const newServerNames = repoServerNames.filter(name =>
            !localConfig.mcpServers || !localConfig.mcpServers.hasOwnProperty(name)
        );

        if (newServerNames.length > 0) {
            changes.push(`Added ${newServerNames.length} new non-conflicting mcpServers from repository: ${newServerNames.join(', ')}`);
        }
    }

    const mergedConfig = deepMergeWithProtection(localConfig, repoConfig, '', { pruneHooks });
    const configsAreEqual = JSON.stringify(localConfig) === JSON.stringify(mergedConfig);

    if (!configsAreEqual && !dryRun) {
        await atomicWrite(localConfigPath, mergedConfig, {
            preserveComments,
            backupOnSuccess
        });
    }

    return {
        updated: !configsAreEqual,
        changes
    };
}

export function getProtectedKeys(): string[] {
    return [...PROTECTED_KEYS];
}
