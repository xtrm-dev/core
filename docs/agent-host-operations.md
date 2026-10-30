# Agent host operations (`xt host`)

The agent host is the per-user daemon behind intercom (Pi `SendMessage` /
`ListAgents`), the desktop app and the Claude presence hooks. It listens on a
loopback HTTP port and on a producer socket; `~/.xtrm/run/agent-host.json`
announces both (`port`, `socket`, `pid`).

## Is it healthy?

```bash
xt host status            # running | unresponsive | not running; exit 1 unless healthy
xt host status --json     # { running, healthy, state, info }
```

`status` probes `GET /v1/health` with a 500 ms budget. A live pid alone is not
a working host: a host whose event loop is blocked keeps its pid while every
request times out, and `status` reports that as `unresponsive`.

`GET /v1/health` does no registry or index work. It answers
`{"status":"ok","pid":…,"uptimeMs":…}`, so its latency measures the event loop
itself. Use it, never `GET /v1/sessions`, for liveness probes: the bare
session list includes every history row (about 1 MB with a large journal set).

Session list scopes:

| Request | Rows |
|---|---|
| `GET /v1/sessions` | live sessions plus history (the desktop app reads this) |
| `GET /v1/sessions?scope=all` | the same, explicitly |
| `GET /v1/sessions?scope=live` | live sessions only (intercom rosters) |

## Starting and restarting

- `xt host ensure` starts a detached host when none answers, or reuses the
  running one. The detached host gets a scrubbed environment (process basics
  only): it serves every session and must not inherit the identity of the
  session that started it.
- Pi sessions self-heal: on session start, and whenever a Pi bridge loses its
  host connection, the extension probes the socket and runs one background
  `xt host ensure` if nothing answers.
- Under systemd the operator-owned user unit is `xtrm-agent-host.service`.
  xtrm-tools does not generate or edit it. A watchdog can call
  `xt host status` (exit 1 when unresponsive) and restart the unit.
  Restarting the host drops held wakes: the wake mailbox is in memory.

## Logs

`~/.xtrm/run/agent-host.log` (detached hosts started by `xt host ensure`).
Past 1 MiB the log rotates to `agent-host.log.1` on the next start instead of
being truncated, so the log of a wedged host survives the restart after it.
A cwd whose repository lookup fails logs one line and is retried after
10 minutes; a lookup sweep wedged on hung git processes logs once after 60 s.
