# Workers: rules every dispatched worker follows

Read this file at launch and after every compaction. It applies to every worker of a programme:
`xt claude` and `xt pi` builders, helpers, board agents, investigation workers and specialists.
The coordinator part is in SKILL.md; this file is the worker part.

## 1. Your contract and your reports

1. Your Substrate issue is your brief. Claim it with `--holder <your name>` and a TTL that covers your next checkpoint. Renew it at each checkpoint.
2. Journal each milestone on your issue (`sb journal append <ref> --kind <k> --semantic <file>`). Close with a `result` entry.
3. Report to the coordinator that dispatched you with `SendMessage` (its name is in your primer). A report states facts you verified, and marks claims you did not verify.
4. Paste SHAs from `gh` or `git` output. Never type one.
5. Put scratch files under `~/.cache/<issue-ref>/`. Never delete them. List them in your closure. A file is a draft, never the deliverable ("no files" rule, operator 2026-10-31): post its text to the system of record in the same step. Findings, rulings, reviews, plans and proposals go into Substrate (`sb journal append <ref> --kind finding|decision|result --semantic <file>`), and anything the operator or a Jira ticket needs goes into a Jira comment on that ticket (`scripts/jira.py comment <KEY> <file>` reads the file and posts its text; split above ~30,000 characters, Jira's comment limit is 32,767). A message or comment that only names a `~/.cache` path is incomplete.
6. Never use `sudo`. If a read needs root, record UNKNOWN and continue.
7. Never change a shared environment (the pyright gate env under `~/.cache/mercury-market-data/`, a host venv, another worktree): create a throwaway venv under `~/.cache/<issue-ref>/` instead, and ask the coordinator first when that is not possible (operator 2026-10-31, MMD-3216). Do not run the full local suite or a full `make ci-light`: run targeted tests, and treat the hosted Light gate on the pushed head as the gate.
8. Quote a window's or a ticket's vehicle (commit, PR, image) only from that row's own description or a gh/git read, never from a summary or a neighbouring row (ISSUE-588, 2026-10-31).

## 2. When the operator's attention is needed: tag the operator on Jira (operator, 2026-10-30)

When a question for the operator exists, or something needs the operator's attention (a decision, a review, an approval, a risk), do this in the same cycle:

1. Write ONE comment on the Jira ticket the matter belongs to (the ticket key in your issue, or the programme epic ISSUE-198 if there is none).
2. Start the comment with `@operator`. `scripts/jira.py comment <KEY> <file>` turns `@operator` into a real Jira mention of jagger.xtrm@gmail.com (account 640b87a2314f50881385ea01), which notifies the operator. Plain text "@Dawid" does not notify.
3. Write in plain words. The operator is not technical. State:
   - WHAT needs attention, in one sentence;
   - WHY it needs the operator, in one or two sentences (what happens if nobody answers, and by when);
   - the choice, with your recommendation first, when it is a decision;
   - WHERE to look: the link to every artifact you produced (review page URL, PR URL, the Jira comment or journal entry that holds the text). Never a file path alone.
4. Read the comment back and record its id in your journal and in your report to the coordinator.
5. While Jira writes are owned by another agent (for example a paused or dedicated Jira writer), hand the exact comment text to the coordinator or the board helper instead of posting, and say that it must carry `@operator`.
6. Do not tag the operator for routine progress, for technical choices you can make yourself, or twice for the same matter.

The coordinator also puts the same matter as a row in the Tabellone `questions` collection (SKILL.md, Daily operations rule 15), with the ticket link and the artifact link.

## 3. Artifacts

Every audit, investigation or research report becomes a review page (light `mercury-visual-style` page). Its full text also goes into Substrate (journal entry on your issue) and, when it concerns a Jira ticket, into a comment on that ticket (rule 1.5). The operator comment and your report link to the page and the comment, not to a file.

## 4. Processes

Never kill, `pkill` or `kill -9` a process you did not start yourself, and never match by a pattern that can hit another lane's process. On 2026-10-30 a reviewer subagent ran `pkill -f "MMD-3012/gated.sh"` and may have killed other lanes' queued test runs. Stop your own work by its PID or by its own stop command.
