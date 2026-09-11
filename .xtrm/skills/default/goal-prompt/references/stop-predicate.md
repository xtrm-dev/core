# Stop-hook predicate shape

Moved from the skill root to keep the root within its line budget; the root
`SKILL.md` points here for the full predicate contract. Source: global
`goal-prompt` `SKILL.md` "Stop-hook predicate shape" section, with the
illustrative artifact names generalized (global used a work-specific handoff
example; the shape below keeps the same contract with generic placeholders).

`/goal <text>` installs `<text>` as a Stop-hook condition. The hook re-checks it
every time the agent tries to stop. The condition text has TWO zones with different
jobs — do not conflate them:

- **Steps / directives / scope / HARD STOP list / ordering** — the bulk. Keeps the
  agent on rails; re-shown at every checkpoint so the agent cannot drift off it.
  These are guidance, not pass/fail criteria.
- **Stop predicate** — the LAST line. One sentence, testable from the transcript
  alone (no exec, no repo state the hook cannot see). This is what the hook grades.

The hook cannot exec tools, cannot read files, cannot query beads. It reads the
last assistant turn(s) and decides. So the predicate must name an emitted artifact
the transcript will contain:

```text
Condition holds when the final assistant message contains a handoff block with
READY set to YES or NO and NEXT_ACTION filled.
```

An honest-failure emission (e.g. `READY: NO + BLOCKERS: wrong workspace`) must
satisfy the predicate — otherwise the goal is a permanent lock and the only exit
is `/goal clear`. If honest failure does not satisfy the predicate, the predicate
is wrong: rewrite it around the artifact, not around the wished-for outcome.

Anti-pattern: enumerating SUCCESS gates INSIDE the predicate. `SUCCESS — all of:
1. X implemented, 2. Y diagnosed, 3. Z reviewed …` reads to the hook as literal
stop-blockers spanning repos and sessions. Keep the gates as directives above;
end the condition with one artifact-shaped predicate.
