# Lane automation: the state files, watchers and write paths behind a helper

The batch rules cover Jira and Substrate. This file covers the helper's own machinery, because the
failures that cost the most on 2026-10-25 were in the tooling, not on the board. Each section names
a failure that actually happened, the rule that prevents it, and the check that proves the rule is
in force.

## State files are interfaces: read the consumer before reshaping one

Failure: the own-comment ledger was rewritten as `{"ids": ["15110"]}` with string ids while three
scripts read a plain JSON list of integers. `set(dict)` yields `{'ids'}`; `int('15110') in {'15110'}`
is False; the loader raised nothing and returned an empty set, so the watch reported the lane's own
comments as foreign and three cycles were spent re-arming.

- Before changing the shape of any file under `~/.cache/<lane>/`, grep for its readers and read the
  loader, not just the writer.
- Normalise at the boundary (`{int(x) for x in raw}`) so either shape works.
- A file that cannot be parsed must print a warning and never return an empty collection: an empty
  result is indistinguishable from "nothing to report", which is the failure mode this whole file
  exists to prevent.

Check: copy the file, corrupt the shape deliberately, and confirm the consumer complains instead of
reporting success.

## Prove the filter before trusting its result

Three failures in one day, all silent:

1. A path filter named `analytics/shared/hmm` and `scripts/data/feeds/session.py`. Neither exists
   (the real files are `analytics/volatility/hmm.py` and `*/session*.py`), so two of six paths
   matched nothing and the merged table looked complete while missing its middle.
2. `git log --merges` returned 11 rows where the merged-PR set held 24: most PRs here are
   squash-merged, so a merge commit never carries their change.
3. `JQL project = INFRA` returned 0 issues: `INFRA-xxxx` are Substrate refs, and a JQL that names a
   nonexistent project returns an empty set rather than an error.

- Every filter needs a known-positive control: run it against one item you can see by eye. An empty
  control means the filter is wrong, not that the world is empty.
- For "what did this change touch", read the PR file list, not the commit graph. For a project or
  label key, confirm it exists before reporting a zero from it.

## One watcher, and it must advance its own baseline

Failure: two cycle watchers ran at once, so the cadence doubled; and the merge baseline file was
never advanced, so the first new merge re-fired on every poll. That is worse than noise: while it
kept re-reporting the same merge, a different merge arriving in the same window would have been
invisible.

- Exactly one watcher per lane. Stop the old one before arming the new one, and say which id is live.
- After reporting an event, write the baseline forward in the same call, so the next poll starts from
  what was already reported.
- Hold the baseline as a **line set** and print only lines that are new or changed. A whole-output compare
  makes every row ageing out of a `updated >= -45m` window look like an event (2026-10-26: a row leaving
  the window was reported as a board change before the defect was found).
- The first poll after arming writes the baseline and prints **nothing**. A startup that dumps every
  current row reads as a burst of news and teaches the reader to discount the channel (same lane, minutes
  after the age-out defect: one bad watcher design replaced by another).
- Never edit a running watcher's script. Bash re-reads it from a byte offset, so a one-line change can
  execute whatever now sits at that offset. Stop the watcher, replace the script, arm again, and write the
  new id into the live-watch state in the same turn.

Check: after a re-arm, run the detector once by hand and confirm it returns empty.

Liveness is a line the loop prints, never the absence of noise, and never a CPU reading. A supervisor
waiting on a network child shows `00:00:00` CPU and `S` state, which is the normal shape of a healthy
worker mid-cycle (2026-10-26: a 10:30Z loop cycle took over 6 minutes on a larger bucket and looked
stalled by CPU alone). Read the process tree — supervisor, child, child's child — or the `ROUND` line.
And treat one sample as a sample: the child observed at 10:36Z was gone by 10:38Z.

## Post through one path, and let it identify itself

Failure: the own-comment ledger was appended in a later command than the POST, and a poll landed in
the gap three times (15109, 15110, 15117). A second, subtler failure came from verifying the fix:
`signed` was checked with `json.dumps(body)`, and ADF serialises the em-dash as `\u2014`, so a
comment that did carry the lane signature was reported as unsigned.

- One write helper that stamps a lane signature, POSTs, and records the returned comment id before
  returning. The signature also lets the watch's text filter catch a lane comment whose id has not
  reached the ledger yet.
- Verbatim relayed text is the one exception: post it unsigned, rely on the atomic ledger write, and
  say in the comment that the text is the coordinator's verbatim.
- Assert on parsed content, never on serialised bytes: flatten the ADF to text first, then compare —
  and treat a `hardBreak` node as a newline while flattening. Without it every multi-line relay reports a
  false mismatch (2026-10-26: the first comparison said `False` on text that had posted character-identical).
- Verbatim relay: write the coordinator's text to a file, post from the file, read back by the returned id,
  compare byte-for-byte (both lengths and characters), and report the id with both lengths. A read-back by
  "newest comment" is not a read-back: ordering puts newest first.

## The lane's own signals: context, CLI cost, process-scoped Fleet

The pane footer is the authoritative context reading — `19.6%/1.0M` on the last line of the agent's own
pane — so read it with `tmux capture-pane -p -t <session:window.pane> | tail -3` instead of estimating.
A transcript sum is a fallback with a trap: 672,208 characters ≈ 177k tokens was read as "past the limit"
against an assumed 200k window on 2026-10-26 and the real reading was 18% of 1M. The absolute number is
real; converting it to pressure needs the window from the same source.

- `sp list` took about six minutes: the specialists CLI is a last resort, not a poll.
- `specialist_status` is **process-scoped**. After the hosting process dies the Fleet is empty whether or
  not the work finished, so a resume verifies a specialist through its artefacts and its own journal
  entries (MMD-2918, 2026-10-26), never through an empty Fleet.

## Deadline alarms

A deadline further away than the `Monitor` ceiling (30 min) needs `BashBackground`, not `Monitor`: a
`Monitor` armed with `sleep` past its own timeout expires with **0 events and no line**, which looks exactly
like a quiet board. `BashBackground` takes a 2-hour timeout, notifies on exit, and needs no polling, so arm
one `sleep`-until-deadline command and end the turn. Confirmed 2026-10-25: a 77-minute `Monitor` for the
22:05Z duty expired silently at 21:17Z.

- Cap: no single wait longer than 110 min; chain longer waits in the same call that re-arms.
- A wait that fires early with no output is a dead alarm, not a quiet board.
- Check that the guard outlives the deadline it guards. A monitor that expires before the event leaves the gap
  exactly where the event is, and it looks armed the whole time. Two instances in one morning (2026-10-26):
  a 7200 s wait for a 05:45Z deadline died at 05:37Z, and a round monitor expiring 10:56Z together with a
  watchdog expiring 11:10Z left a 11:12Z absence deadline uncovered by either. Compute expiry minus deadline
  for every guard and re-arm from the expiry, not from the next convenient moment.
- Every wake re-reads state live (master head, open PRs into stable, migration head from the repo AND the
  live database, `load1` + memory `full avg10`); never act on a remembered value.

## A gate must be satisfiable, resolvable and self-evidencing

A condition that authorises an action has to be one a stranger can satisfy and verify later. A HOLD or state
file that names a session which has since stopped is unsatisfiable, and it fails in both directions at once:
a literal reader treats it as a permanent block, and a reader who notices the dead name concludes the gate is
void. Both readings are wrong and neither announces itself.

The durable form names a role and carries a check the reader can execute:

- Name the owning object, not the person: the claim holder of the coordinator issue, and require that claim to
  be **live**. A holder whose claim has lapsed is not an authority, so the reader escalates instead of
  publishing — the case a name-only gate silently gets wrong, in the same shape as reading an empty caller
  set as an all-clear.
- Carry the role's validity window and the executed check **with its timestamp**. A value copied at handover
  time is already wrong: the coordinator claim moved 69 → 72 generations inside one night.
- Write the state the gate certifies into the file, not only the prohibition. "NOT PUBLISHED, verified
  <when> by <how>" lets a reader verify instead of trust.

Worked instance 2026-10-27: a grains HOLD marker required "mon-coord's word plus confirmation" after that
coordinator handed the board over and stopped. The marker was amended to name the current coordinator with its
uds address, to date and reason the authority change inside the file, and to carry the hold's own verified
state. Reader-executable check: `sb issue show <coordinator issue> --json` → `.data.claim.holder` plus a
future `expiresAt`, and the coordinator's uds socket present under `/run/user/1000/cc-socks/`.
