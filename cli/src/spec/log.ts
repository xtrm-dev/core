/**
 * Structured stderr log channel for xt spec commands.
 * One JSON object per line, timestamp-prefixed. Consumed by CI / xt report.
 *
 * Keep this dependency-free so the validator core stays I/O-free
 * (logEvent is only called from CLI command surfaces, never from validate/checks/scrutiny).
 */
export interface LogFields {
    event: string;
    [key: string]: unknown;
}

export function logEvent(fields: LogFields): void {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, component: 'xt.spec', ...fields });
    process.stderr.write(line + '\n');
}
