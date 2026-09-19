# Handoff

## Message template — pointer first
Native messaging makes multiline text safe, but do not turn it into transcript dumping.

For durable work, send a compact handoff containing:

```text
TASK: <one-sentence objective>
AUTHORITY: <Issue ref @ pinned revision / PR / worktree if applicable>
SCOPE: <repo/path/worktree>
CONSTRAINTS: <only the load-bearing ones>
OUTPUT: <what to return and where durable evidence belongs>
REPLY: <none | ask if blocked | explicit completion reply>
```

Prefer an Issue/file/PR pointer for large specifications. Native messages are the wake/coordination lane; they are not the durable task database.

## Assisted handoff protocol
For work worth surviving a crash:

1. Create or identify the durable Substrate Issue first (attested + claimed before execution).
2. Ensure the target owns a separate worktree when parallel writes would otherwise conflict.
3. Discover the target through the native roster.
4. Send the compact pointer-first handoff using the transport matrix.
5. Record ownership/status as claim + Journal entries, not only in the chat message.
6. Let the target ask back natively if blocked.
7. Require the final message to point to durable evidence: commit, PR, file, result, test evidence, Journal result, or Closure.

No `/tmp` pointer file is required merely because the prompt has multiple lines. `/tmp` remains appropriate only for ephemeral large local context that should not become durable work authority.

## Bare launch
For a new general-purpose visible worker, use the current `xt` launch surface, not a hand-built terminal command. Check `xt --help` / provider help for exact flags.

After launch:

1. assign a unique native session name;
2. verify the worker appears in the appropriate native roster;
3. only then hand off work.

If a required skill must be loaded, do it at launch/session-local startup. Do not send the slash command as a peer message.

## Retrieval hierarchy — what counts as evidence
Prefer durable result surfaces over conversational text:

1. Git/PR/commit/test artifact required by the task.
2. Issue state, Journal, and Closure evidence.
3. `sp result <job-id> --json` for actual Specialist jobs.
4. Native peer reply/message for coordination context.
5. Pi/Claude transcript only when the conversation itself is the evidence.
6. `tmux capture-pane` only for transient live-state UI/debugging.

Never make `capture-pane` the final-result protocol — it is live-state only.

A native delivery receipt means transport progress, not result validity.
