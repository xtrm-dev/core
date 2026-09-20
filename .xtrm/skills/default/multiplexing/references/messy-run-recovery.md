# Messy-run recovery

If an agent goes off rails:

1. Freeze new work assignment to it.
2. Send one concise native correction stating the violated constraint and required recovery.
3. If there is a stale Pi intercom request, cancel/supersede it explicitly where appropriate.
4. Inspect the durable worktree/Issue/Git state (Issue revision + claim state, Journal, worktree, branch).
5. If the runtime is unresponsive or stuck at a terminal-level condition, inspect via tmux and interrupt only then.
6. Close/reassign spurious work items deliberately; do not let chat history become the recovery ledger.
