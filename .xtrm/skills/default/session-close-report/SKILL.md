---
name: session-close-report
description: |
  Generate or update the structured technical handoff report at session close.
  Prefer one same-day SSOT report: update the latest report for today when it
  exists, otherwise run `xt report generate`, then fill every `<!-- FILL -->`
  section from orchestrator context.
---

# session-close-report

## When to use

Invoke this skill at the end of a productive session — after issues are closed,
code is committed, but before final push. It produces the handoff report that
the next agent reads to start cold without losing context.

## Report identity rule

Prefer a single same-day SSOT handoff report.

Before generating anything, check existing reports:

```bash
xt report list
ls -t .xtrm/reports/*.md 2>/dev/null | head
```

Decision:
- If a report for today already exists, update the latest same-day report.
- If multiple orchestrators ran today, merge your context into that same report;
  do not create a competing handoff unless the operator explicitly asks for a
  separate report.
- If no suitable same-day report exists, run `xt report generate` and fill the
  new skeleton.

When updating an existing report, preserve prior orchestrator content. Append,
merge, or revise sections so the file remains one coherent handoff package — do
not overwrite earlier waves, issue context, problems, or decisions unless they
are factually superseded.

## Workflow

### 1. Select report: update existing or generate new

For same-day update:

```bash
REPORT=$(ls -t .xtrm/reports/$(date +%F)-*.md 2>/dev/null | head -1)
```

If `$REPORT` is non-empty, read and update it.

If no same-day report exists:

```bash
xt report generate
```

This collects data from git log, bd, .specialists/jobs/ and writes a skeleton
to `.xtrm/reports/<date>-<hash>.md` with YAML frontmatter and pre-filled tables.

### 2. Read the target report

Read the chosen report completely enough to understand existing content.

Skeleton reports have `<!-- FILL -->` markers in every section that needs your
input. Existing same-day reports may already be partially filled; update those
sections with the new session context and remove any now-stale placeholders.

### 3. Fill or update every section from your context

You are the orchestrator. You have the full session context. The CLI only
collected raw data — you provide the meaning.

When updating an existing same-day report:
- Add new waves, issues, commits, problems, and decisions without duplicating
  existing rows.
- Update summary/frontmatter counts to cover the whole same-day handoff, not
  just your sub-session.
- Reconcile stale “open issues” entries if you closed them later in the day.
- Keep one chronological/coherent narrative instead of separate mini-reports.

**For each section, here is exactly what to write:**

#### Summary
One dense paragraph. What was accomplished, key decisions made, discoveries,
outcomes. Technical prose — no filler, no "in this session we...". Lead with
the most important result. For same-day updates, summarize the whole day’s SSOT
state, including earlier orchestrators and your additions.

#### Issues Closed
The skeleton has a flat table. Restructure it:
- Group by category: bugs discovered, backlog items, cleanup/closures, features
- If specialists were used, add Specialist and Wave columns
- Expand terse close reasons into useful context
- When updating an existing report, add newly closed issues and revise stale open
  entries that are now closed

#### Issues Filed
Add every issue you created this session. The **Why** column is mandatory —
explain the rationale for filing, not just what the issue says.

Update the `issues_filed` count in frontmatter.

#### Specialist Dispatches
If specialists were dispatched:
- Build a Wave summary table: Wave number, specialists, models, outcomes
- Add a Problems sub-table for any failed/stalled dispatches
- Update `specialist_dispatches` and `models_used` in frontmatter

If no specialists were used and the report has no prior specialist dispatches,
delete this section. If prior dispatches exist, keep and extend them.

#### Problems Encountered
Every problem hit during the session. Root Cause and Resolution columns are
mandatory. Include: bugs discovered, wrong approaches tried, blockers hit,
tooling failures. If no problems exist anywhere in the same-day report, delete
this section entirely.

#### Code Changes
The skeleton lists files. Add narrative:
- Explain key modifications (not every file — focus on the important ones)
- Group logically if many changes (e.g., "CLI commands", "Hook changes")
- Note architectural decisions embedded in the changes
- For same-day updates, include changes from all orchestrators that contributed
  to the final pushed stack

#### Documentation Updates
List doc changes, skill updates, memory saves, CHANGELOG entries.
Delete if no doc work happened.

#### Open Issues with Context
This is the most valuable handoff section. For each open issue:
- **Context / Suggestions**: What the next agent needs to know. Current state,
  blockers discovered, suggested approach, files to look at, gotchas.
- Group into "Ready for next session" and "Backlog" subsections
- Put the most actionable items first
- If an issue listed earlier in the day was closed later, remove it from open
  issues and move it to Issues Closed with closure context

#### Memories Saved
List all `bd remember` calls made this session. If the skeleton missed any,
add them. If none were saved, note why (nothing novel, or deferred).

#### Suggested Next Priority
Ordered list of 1-4 items with rationale for each. Based on:
- Dependency order (what unblocks the most)
- User's stated intent (if they mentioned what's next)
- Urgency of discovered issues
- Blocked items about to unblock

For same-day updates, make this the next priority from the final state of the
whole day, not from an earlier partial state.

### 4. Update frontmatter

Ensure all frontmatter counts are accurate after filling/updating:
- `issues_filed` — actual count represented in the report
- `specialist_dispatches` — actual count represented in the report
- `models_used` — list of models that did work represented in the report
- `issues_closed` — actual closed issue count represented in the report
- `commits` — commit count represented in the report, if known

### 5. Commit the report

Reports are versioned handoff artifacts and should be tracked.

```bash
git add .xtrm/reports/
git commit -m "session report: <date>"
```

If you updated an existing same-day report after an earlier report commit, commit
that update with the same message style or fold it into the current final commit
before push.

## Quality bar

The reference is `~/projects/specialists/.xtrm/reports/2026-03-30-orchestration-session.md`.
Every report must match that level of detail. Specifically:

- No empty `<!-- FILL -->` markers left in the final output
- No duplicate same-day reports unless explicitly requested by the operator
- Every closed issue has context, not just an ID
- Every open issue has actionable handoff suggestions
- Problems section captures root causes, not just symptoms
- Summary is a dense technical paragraph, not a list of bullet points
- Same-day updates preserve earlier orchestrator context while making the final
  file read as one SSOT handoff package

## CLI commands

| Command | Purpose |
|---------|---------|
| `xt report generate` | Collect data, write skeleton when no suitable report exists |
| `xt report show [target]` | Display latest or specified report |
| `xt report list` | List all reports with frontmatter summary |
| `xt report diff <a> <b>` | Compare two reports |
