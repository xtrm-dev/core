# Scope

## Authority boundary
Own:

- native peer discovery and transport selection;
- assisted handoffs between independent sessions;
- live coordination and clarification loops;
- operator-facing multi-session inventory;
- cleanup hygiene;
- messy-run recovery;
- session naming convention;
- explicit terminal fallback for unsupported runtimes.

Do not own:

- specialist chain orchestration → `/using-specialists`;
- governed ChainRun communication → XTRM Channels;
- Substrate Issue acceptance/work authority;
- new agent runtime design;
- provider-specific hidden IPC schemas beyond the installed adapters;
- silent process spawning merely to make a message deliver.

## When this skill applies
Applies:

- "what's running?" / multi-session inventory;
- hand off a bounded task to another already-running Claude or Pi session;
- coordinate independent worktrees/repos;
- ask a peer for a decision or finding;
- monitor a long-running independent Claude session through native idle notification;
- recover a session that went off contract;
- clean up stale sessions/worktrees/processes;
- coordinate one operator goal across multiple independent sessions.

Does not apply:

- Specialists chain orchestration;
- an XTRM ChainRun already using canonical Channels;
- in-process subagent/team orchestration whose harness already owns lifecycle;
- a single-session deep task;
- designing a new cross-provider bus.
