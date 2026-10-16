/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;
	let lastWorktreeReminderCwd: string | null = null;

	// CORE-2403: the `xt end` worktree reminder lived in the retired
	// session-flow extension. It was never Beads logic, so it is restored
	// here rather than retired with the gates.
	function isWorktree(cwd: string): boolean {
		return cwd.includes("/.xtrm/worktrees/") || cwd.includes("/.claude/worktrees/");
	}

	// Track the current entry ID when user messages are saved
	pi.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("turn_start", async () => {
		// Create a git stash entry before LLM makes changes
		const { stdout } = await pi.exec("git", ["stash", "create"]);
		const ref = stdout.trim();
		if (ref && currentEntryId) {
			checkpoints.set(currentEntryId, ref);
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Clear checkpoints after agent completes
		checkpoints.clear();

		const cwd = ctx?.cwd || process.cwd();
		if (ctx?.hasUI && isWorktree(cwd) && lastWorktreeReminderCwd !== cwd) {
			ctx.ui.notify("Run `xt end` to create a PR and clean up this worktree.", "info");
			lastWorktreeReminderCwd = cwd;
		}
	});
}
