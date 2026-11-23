# Messaging and continuation

For a parked session, wake with `xt attach <worktree> --fresh` in the recorded `session:window`, or use `--workers`/`--pane <session/window|%pane>`. If the target is gone, omit it and let `~/.xtrm/config/launch.json` role/default placement choose. Do not manually join panes or apply layouts.


## Message classes

Use three intent classes regardless of transport:

- **FYI** — no answer required; status/pointer only.
- **Decision/request** — an answer is required; preserve correlation until fulfilled.
- **Correction/steer** — changes active work; recipient must incorporate it or report why
  it cannot.

Keep payloads small. Durable detail belongs in the work item or referenced artifact.

## Correlation

When the runtime returns a message/reply/correlation key, keep it. Acknowledging receipt
is not the same as fulfilling a required reply. A reply should close the original
obligation through the runtime's supported mechanism rather than creating an unrelated
new message.

## Waiting

Prefer event-driven waits, completion callbacks, runtime notifications, or monitored
state transitions. Poll only when no event surface exists, with bounded cadence and an
explicit timeout/escalation condition.

## Recovery

A restart-safe coordination path needs durable identity plus enough state to reconstruct:
requester, recipient, work item, pending obligation/condition, and current output
location. Never invent marker files when the runtime already owns this state.

## Handoff

If the coordinator or worker cannot safely continue because of context pressure, persist
pending replies/conditions as part of the handoff and verify another participant can
resume them.