import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { SubprocessRunner, EventAdapter } from "../../src/core";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Substrate fallback (CORE-2357) -------------------------------------------
// `bd` is a retired board. Where `bd` has no database (migrated repos), no
// bd claim can ever exist, so the gate would block every edit forever even
// with a live Substrate claim. The fallback below engages ONLY when `bd`
// itself errors in that cwd; bd-backed repos behave exactly as before.
//
// Per-session markers live under user scope (~/.xtrm/claims/), written only
// on observed SUCCESSFUL `sb issue claim <ref>` commands and cleared on
// observed successful close/release/cancel/reopen of the same ref — the
// same shape as bd's own claimed:<session> KV. XTRM_TEST_HOME overrides
// $HOME so tests never touch the operator's state.
export function claimsRoot(): string {
const home = process.env.XTRM_TEST_HOME || os.homedir();
return path.join(home, ".xtrm", "claims");
}

export function claimMarkerPath(sessionId: string, cwd: string): string {
const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
const repo = createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
return path.join(claimsRoot(), `${safe}.${repo}`);
}

/** An id token, never a flag: rejects `--claim`-as-id garbage (CORE-2357). */
export function isIssueRefToken(token: string | null | undefined): token is string {
return typeof token === "string" && /^(?!-)[A-Za-z0-9][\w:.-]*$/.test(token);
}

export function parseSbClaimRef(command: string): string | null {
const match = command.match(/\bsb\s+issue\s+claim\s+(\S+)/);
return match && isIssueRefToken(match[1]) ? match[1]! : null;
}

export function parseSbUnclaimRef(command: string): string | null {
const match = command.match(/\bsb\s+issue\s+(?:close|release|cancel|reopen)\s+(\S+)/);
return match && isIssueRefToken(match[1]) ? match[1]! : null;
}

export function readSbMarker(sessionId: string, cwd: string): string | null {
try {
const ref = fs.readFileSync(claimMarkerPath(sessionId, cwd), "utf8").trim();
return isIssueRefToken(ref) ? ref : null;
} catch {
return null;
}
}

export function writeSbMarker(sessionId: string, cwd: string, ref: string): void {
fs.mkdirSync(claimsRoot(), { mode: 0o700, recursive: true });
fs.writeFileSync(claimMarkerPath(sessionId, cwd), `${ref}\n`, { mode: 0o600 });
}

export function clearSbMarker(sessionId: string, cwd: string, ref?: string): void {
try {
const marker = claimMarkerPath(sessionId, cwd);
if (ref !== undefined) {
	const current = readSbMarker(sessionId, cwd);
	if (current !== ref) return;
}
fs.unlinkSync(marker);
} catch {
// already absent — nothing to clear
}
}

/**
 * Rechecks a marker against the Substrate board.
 * - "claimed": live claim, edits allowed.
 * - "released": no live claim (released/closed/cancelled/unknown ref) — caller clears and blocks.
 * - "unknown": `sb` itself flaked (non-zero/empty/unparsable). The marker
 *   stands: it is positive evidence of an observed successful claim, and
 *   there is no bd to fall back to. Documented, deliberate.
 */
export async function validateSbClaim(ref: string, cwd: string): Promise<"claimed" | "released" | "unknown"> {
const result = await SubprocessRunner.run("sb", ["issue", "show", ref, "--json"], { cwd });
if (result.code !== 0 || !result.stdout.trim()) return "unknown";
try {
const parsed = JSON.parse(result.stdout);
const data = parsed?.data ?? parsed;
const claimState = data?.claimState;
const claim = data?.claim;
if (claimState === "claimed") return "claimed";
if (claim && !claim.releasedAt) return "claimed";
return "released";
} catch {
return "unknown";
}
}

/** True when `bd` itself is dead in cwd (missing binary or no database). */
export async function isBdDead(cwd: string): Promise<boolean> {
const result = await SubprocessRunner.run("bd", ["kv", "get", "claimed:__xtrm_probe__"], { cwd });
return result.code !== 0;
}

export default function (pi: ExtensionAPI) {
	const getCwd = (ctx: any) => ctx.cwd || process.cwd();

	let cachedSessionId: string | null = null;

	// Resolve a stable session ID across event types.
	const getSessionId = (ctx: any): string => {
		const fromManager = ctx?.sessionManager?.getSessionId?.();
		const fromContext = ctx?.sessionId ?? ctx?.session_id;
		const resolved = fromManager || fromContext || cachedSessionId || process.pid.toString();
		if (resolved && !cachedSessionId) cachedSessionId = resolved;
		return resolved;
	};

	const getSessionClaim = async (sessionId: string, cwd: string): Promise<string | null> => {
		const result = await SubprocessRunner.run("bd", ["kv", "get", `claimed:${sessionId}`], { cwd });
		if (result.code !== 0) return null;
		const claim = result.stdout.trim();
		return claim.length > 0 ? claim : null;
	};

	const clearClaimMarker = async (sessionId: string, cwd: string) => {
		await SubprocessRunner.run("bd", ["kv", "clear", `claimed:${sessionId}`], { cwd });
	};

	const isIssueInProgress = async (issueId: string, cwd: string): Promise<boolean | null> => {
		const result = await SubprocessRunner.run("bd", ["show", issueId, "--json"], { cwd });
		if (result.code !== 0 || !result.stdout.trim()) return null;
		try {
			const parsed = JSON.parse(result.stdout);
			const issue = Array.isArray(parsed) ? parsed[0] : parsed;
			if (!issue?.status) return null;
			return issue.status === "in_progress";
		} catch {
			return null;
		}
	};

	const getActiveClaim = async (sessionId: string, cwd: string): Promise<string | null> => {
		const claim = await getSessionClaim(sessionId, cwd);
		if (!claim) return null;

		const inProgress = await isIssueInProgress(claim, cwd);
		if (inProgress === false) {
			await clearClaimMarker(sessionId, cwd);
			return null;
		}

		return claim;
	};



	// --- Claim-lookup cache (run-scoped) -----------------------------------------
	// getActiveClaim spawns bd kv get (~850ms) + bd show (~300ms). Running these on EVERY
	// mutating tool call added ~1s to each edit. Cache the resolved claim for the lifetime
	// of the run and invalidate only when we OBSERVE a claim/close/KV mutation in the
	// tool_result hook below. xtrm-64pl0: replaces the old 3s time-based TTL, which re-spawned
	// bd every 3s even when claim state had not changed.
	let activeClaimCache: { sessionId: string; cwd: string; value: string | null } | null = null;

	const invalidateClaimCache = (): void => {
		activeClaimCache = null;
	};

	const getActiveClaimCached = async (sessionId: string, cwd: string): Promise<string | null> => {
		if (activeClaimCache && activeClaimCache.sessionId === sessionId && activeClaimCache.cwd === cwd) {
			return activeClaimCache.value;
		}
		const value = await getActiveClaim(sessionId, cwd);
		activeClaimCache = { sessionId, cwd, value };
		return value;
	};

	const stripQuoted = (command: string): string => command.replace(/'[^']*'|"[^"]*"/g, "");
	const isSpecialistsSubprocessCommand = (commandUnquoted: string): boolean =>
		/\bspecialists\s+(run|resume|result|feed|stop|status)\b/.test(commandUnquoted);

	pi.on("session_start", async (_event, ctx) => {
		cachedSessionId = ctx?.sessionManager?.getSessionId?.() ?? cachedSessionId;
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const cwd = getCwd(ctx);
		if (!EventAdapter.isBeadsProject(cwd)) return undefined;
		const sessionId = getSessionId(ctx);

		// xtrm-64pl0: the edit gate no longer falls back to `bd list` (hasTrackableWork) to
		// decide whether the board has work. Within a beads project (isBeadsProject guard above)
		// an edit without an active claim is blocked directly — no bd list subprocess. Behavior
		// change: empty-board edits in a beads project now require a claim too (documented in
		// CHANGELOG.md and docs/pi-extensions.md).
		if (EventAdapter.isMutatingFileTool(event)) {
			const claim = await getActiveClaimCached(sessionId, cwd);
			if (claim) return undefined;
			// bd gave nothing. If bd itself is dead here (retired board), the
			// session-scoped Substrate marker applies (CORE-2357).
			let sbHint = "";
			if (await isBdDead(cwd)) {
				const marker = readSbMarker(sessionId, cwd);
				if (marker) {
					const decision = await validateSbClaim(marker, cwd);
					if (decision === "claimed") return undefined;
					if (decision === "released") clearSbMarker(sessionId, cwd);
				}
				sbHint = "\n  sb issue claim <ref> --holder <you>  (bd has no database here; Substrate claims apply)";
			}
			if (ctx.hasUI) {
				ctx.ui.notify("Beads: Edit blocked. Claim an issue first.", "warning");
			}
			return {
				block: true,
				reason: `No active claim for session ${sessionId}.\n  bd update <id> --claim${sbHint}\n`,
			};
		}

		if (isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			const commandUnquoted = stripQuoted(command);

			if (isSpecialistsSubprocessCommand(commandUnquoted)) return undefined;

			if (/\bgit\s+commit\b/.test(commandUnquoted)) {
				const claim = await getActiveClaimCached(sessionId, cwd);
				if (claim) {
					return {
						block: true,
						reason: `Active claim [${claim}] — close it first.\n  bd close ${claim}\n  (Pi workflow) publish/merge are external steps; do not rely on xtrm finish.\n`,
					};
				}
			}
		}

		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event)) return undefined;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		const sessionId = getSessionId(ctx);
		const cwd = getCwd(ctx);

		// xtrm-64pl0: invalidate the run-scoped claim cache when we observe a KV mutation that
		// could change claim state. claim/close mutations are also invalidated further below.
		if (/\bbd\s+kv\s+(set|clear)\s+["']?(claimed:|closed-this-session:)/.test(command)) {
			invalidateClaimCache();
		}

		// Auto-claim on a SUCCESSFUL bd update --claim only (CORE-2357): a
		// failed claim must never print the success notice.
		if (/\bbd\s+update\b/.test(command) && /--claim\b/.test(command) && !event.isError) {
			const issueMatch = command.match(/\bbd\s+update\s+(\S+)/);
			const issueId = issueMatch?.[1] ?? null;
			if (isIssueRefToken(issueId)) {
				await SubprocessRunner.run("bd", ["kv", "set", `claimed:${sessionId}`, issueId], { cwd });
				invalidateClaimCache();
				const claimNotice = `\n\n✅ **Beads**: Session \`${sessionId}\` claimed issue \`${issueId}\`. File edits are now unblocked.`;
				return { content: [...event.content, { type: "text", text: claimNotice }] };
			}
		}

		// Substrate auto-claim/clear (CORE-2357): same shape, user-scope marker.
		if (!event.isError) {
			const sbClaim = parseSbClaimRef(command);
			if (sbClaim) {
				writeSbMarker(sessionId, cwd, sbClaim);
				invalidateClaimCache();
				const claimNotice = `\n\n✅ **Substrate**: Session \`${sessionId}\` claimed issue \`${sbClaim}\`. File edits are now unblocked.`;
				return { content: [...event.content, { type: "text", text: claimNotice }] };
			}
			const sbUnclaim = parseSbUnclaimRef(command);
			if (sbUnclaim) {
				clearSbMarker(sessionId, cwd, sbUnclaim);
				invalidateClaimCache();
			}
		}

		if (/\bbd\s+close\b/.test(command) && !event.isError) {
			const closeMatch = command.match(/\bbd\s+close\s+(\S+)/);
			const closedIssueId = closeMatch?.[1] ?? null;

			if (closedIssueId) {
				await SubprocessRunner.run("bd", ["kv", "set", `closed-this-session:${sessionId}`, closedIssueId], { cwd });
				invalidateClaimCache();
			}

			const closeNotice = closedIssueId
				? `\n\n**Beads**: Work completed for \`${closedIssueId}\`. File edits remain gated on an active claim.`
				: `\n\n**Beads**: Work completed.`;
			return { content: [...event.content, { type: "text", text: closeNotice }] };
		}

		return undefined;
	});
}
