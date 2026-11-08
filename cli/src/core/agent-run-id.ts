/**
 * The run id an agent post carries (CORE-2528).
 *
 * `SUBSTRATE_RUN_ID` wins when the launcher sets one. Otherwise a stable 6-hex
 * id is derived per agent process (boot id + session id + process start time),
 * so two posts from the same session in the same run agree without the operator
 * having to type anything. Never throws and never invents a full-length id.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface RunIdDeps {
    env?: NodeJS.ProcessEnv;
    read?: (file: string) => string;
    sid?: number;
    pid?: number;
    startTime?: string | null;
}

function clockTicks(pid: number, read: (file: string) => string): string {
    try {
        const stat = read(`/proc/${pid}/stat`);
        // comm may contain spaces and parens; fields resume after the last ')'.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[19] ?? '';
    } catch {
        return '';
    }
}

export function resolveAgentRunId(deps: RunIdDeps = {}): string {
    const env = deps.env ?? process.env;
    const explicit = (env.SUBSTRATE_RUN_ID ?? '').trim();
    if (explicit) return explicit;
    const read = deps.read ?? ((file: string) => readFileSync(file, 'utf8'));
    let boot = '';
    try {
        boot = read('/proc/sys/kernel/random/boot_id').trim();
    } catch { /* absent */ }
    // Node has no getsid(); the shell's $$ is inherited, so the session id comes
    // from an injected value or is left out of the hash.
    const sid = deps.sid ?? 0;
    const pid = deps.pid ?? process.pid;
    const start = deps.startTime !== undefined ? (deps.startTime ?? '') : clockTicks(pid, read);
    return createHash('sha1').update(`${boot}:${sid}:${start}`).digest('hex').slice(0, 6);
}
