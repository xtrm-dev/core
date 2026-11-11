# skill-suggest for Claude Code

A Claude Code plugin that suggests **one skill per turn**. It is the Claude port of the Pi `skill-suggest`
extension (CORE-2580, CORE-2594). It runs beside the session as a plugin monitor, never wraps a tool call, never
wakes an idle session, and fails open.

## What the agent sees

At most one line per turn, posted while the turn is still running:

```
[skill-suggest] This request may call for skill "engineering-quality": <the skill's own rule text>. Read /abs/path/SKILL.md before you start. Ignore it if it does not fit.
```

The line is a single notification, 600 characters at most, and always names an absolute path. PRD step 12b records
that a bare pointer was acted on in 6.3% of 446 injections, so the line carries the path and the rule text.

## How it works

```
transcript tail ──► bin/monitor.py ──spawn──► dist/worker.mjs ──► shared/judge.ts ──► Jev
 (read-only)         delivery gate             one per prompt,       roster + two        (api.typesafe.ai)
                     no decisions              exits when done       stages + score
```

1. **`bin/monitor.py`** (Python, about 12 MB resident) follows the session transcript
   (`~/.claude/projects/*/<CLAUDE_CODE_SESSION_ID>.jsonl`). `bin/turnstate.py` reads only the last 256 KB and says
   whether a turn is `running`, `idle` or `unknown`. Unknown is a first-class answer and never delivers.
2. A new **epoch** is the last user row that is not meta and not a tool result. The monitor spawns a worker only for
   a prompt a person typed: not a peer relay, a task notification, a wakeup, a slash command, a bare "continue", or
   this plugin's own nudge.
3. **`dist/worker.mjs`** runs the same `judge()` as the Pi extension (`packages/pi-extensions/shared/judge.ts`): the
   curated roster, two Jev calls and one fitted score. The roster is cached on disk for 5 minutes.
4. The monitor posts the nudge **only if, at that moment, it re-reads the transcript and the same turn is still
   running**. Otherwise it drops the result and logs why. One worker per session; a new epoch kills the old worker;
   a worker that runs over 4 s is killed; at most 3 workers run on the host at once (lock files).

## What the classifier is given

The prompt, plus the small structured context of PRD step 12b: the claimed Issue ref (`SUBSTRATE_ISSUE_REF`, when the
session has one), the last five tool names, and the files those tools touched, which the shortlist uses as service
territory. The work stage is not sent yet. No transcript text is stored or logged; the decision log carries only the
counts (`ctx_tools`, `ctx_files`, `ctx_issue`).

## Act-on rate

After a nudge the monitor watches the transcript for a path-identical `Read` of the suggested file, as the Pi extension
does. The log gets `{"seam":"read_after_suggest","outcome":"read"}` when the agent reads it, or `"outcome":"expired"`
after three turn ends. The act-on rate is `read / (read + expired)` over those rows. A watch that ends otherwise (a second nudge replaces it, or the session exits inside the window) writes no row,
so the rate counts only resolved watches.

## Fail-open rules

| Situation | Result |
|---|---|
| Turn ended before the answer arrived | dropped, logged `turn_ended` |
| A newer prompt arrived | worker killed or result dropped, `epoch_changed` / `stale_epoch` |
| Transcript layout unreadable or changed | state `unknown`, no nudge |
| No Jev key, Jev error, timeout | no nudge, the worker logs the reason |
| Worker crash, over 4 s, or no free slot | no nudge, `worker_failed` / `worker_timeout` / `no_slot` |
| Same skill suggested in the last 30 minutes | dropped, `cooldown` |
| 20 consecutive monitor errors | the monitor exits quietly |

The monitor's stdout is a channel into the model. It prints the nudge line and nothing else.

## Install and run

```
claude --plugin-dir packages/claude-skill-suggest
```

The plugin needs `python3` and `bun` or `node` on `PATH` (it prefers `bun`). The Jev key comes from
`TYPESAFE_API_KEY` or `~/.secrets/typesafe_api_key.txt`.

| Variable | Effect |
|---|---|
| `SKILL_SUGGEST_DISABLE=1` | the monitor exits at once |
| `SKILL_SUGGEST_LOG_DIR` | decision log directory (default `~/.xtrm/skill-suggest`) |
| `SKILL_SUGGEST_CACHE_DIR` | worker roster cache (default `~/.cache/xtrm-skill-suggest`) |
| `SKILL_SUGGEST_SLOTS` | host-wide worker cap (default 3) |
| `SKILL_SUGGEST_HARD_KILL_S` | worker kill time in seconds (default 4) |
| `SKILL_SUGGEST_WORKER_CMD` | JSON array replacing the worker command (tests) |

## Decision log

Rows go to the same `log.jsonl` as the Pi extension, with `"host": "claude"`, `sid` and `epoch`. The worker writes
the decision row (`fire`, `abstain`, or `skip` with the reason); the monitor writes the delivery row (`deliver`, or
`skip` with `turn_ended`, `stale_epoch`, `epoch_unknown`, `cooldown`, `no_slot`, `worker_timeout`).

## Build and test

`npm run check:claude-skill-suggest` runs all three checks below in one command. No CI job runs it yet.

```
sh packages/claude-skill-suggest/scripts/build.sh          # rebuild dist/worker.mjs after changing worker/ or shared/
sh packages/claude-skill-suggest/scripts/check-bundle.sh   # the committed bundle equals a fresh build, node builtins only
cd packages/claude-skill-suggest && python3 -m unittest discover -s tests   # monitor and turn state
cd packages/claude-skill-suggest && bun test                                # worker
cd packages/pi-extensions && bun test tests/skill-suggest                   # the shared judge, incl. the golden payloads
```

`dist/worker.mjs` is committed so the plugin runs without a build step; `check-bundle.sh` fails when it is stale.

## Limits

- The transcript layout is internal and undocumented. The drift guards (`drift:no-user-rows`, `drift:no-stop_reason`,
  bad JSON) turn a layout change into `unknown`, which delivers nothing, instead of a wrong answer.
- Delivery is check-then-write. The re-read happens immediately before the write; a turn that ends in that gap of a
  few milliseconds can still receive a nudge.
- One nudge per epoch: a message typed while a turn runs is a new epoch and is classified on its own.
- A turn that ends through an API-error row inside the 4 s worker window is not recognised as ended; the nudge can then
  land in a session that is about to stop.
- Reuse for CORE-2351 (tool-discipline nudges): `deliver()` is the host-agnostic stale-drop gate (epoch bound, turn
  must still run, never wake an idle session). A tool-discipline producer can feed the same gate.
- Not covered by a measurement yet: behaviour during permission prompts, compaction, subagents and resumed sessions.
