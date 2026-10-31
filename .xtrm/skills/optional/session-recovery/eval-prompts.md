# Eval prompts — session-recovery discovery + behavioral check

 SHOULD trigger:
1. "the host OOMed again, which agent sessions were open and reopen the
   important ones"
2. "I rebooted my machine, my tmux is gone — what was I working on"
3. "make sure session snapshots will be there next time" (phase 0 sanity)

SHOULD NOT trigger:
1. "coordinate agents across panes" → multiplexing (live coordination).
2. "production service is down" → sre-ops (containers, OOM root cause).
3. "resume my issue contract" → using-xtrm / starting-and-resuming-work.

Byte-level behavior check (deterministic):
  scripts/restore-plan.sh <snapshot> exits 0, prints "restore plan" header,
  ranks agent panes before scratch, never suggests killing a tmux session.
  Without snapshot → exit 2 + JSON error naming the missing path.

Token/context cost: SKILL.md ~120 lines; references/manual-playbook.md loads
only when the snapshot is absent (phase 1 fail-open).
