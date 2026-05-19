#!/usr/bin/env bash
# Seeds /tmp/triage-evals/board-a/ with a beads workspace containing 15 issues
# that exhibit every detection pattern the triage skill should catch:
#   - Bug + feature touching same surface (caused-by/blocks candidate)
#   - 2 near-duplicates (supersedes candidate)
#   - 3 siblings on one cluster (epic merger candidate)
#   - Test ↔ impl pair with no edge (validates candidate)
#   - Spawned follow-up with no provenance (discovered-from candidate)
#   - Priority mismatch (bug at P3, feature at P1 same surface)
#   - One stale in-progress issue (to verify the skill doesn't mutate it)
#
# Usage: bash seed-board-a.sh [board-dir]
#   default board-dir: /tmp/triage-evals/board-a
#
# Idempotent: wipes the target dir and re-seeds from scratch.

set -euo pipefail

BOARD_DIR="${1:-/tmp/triage-evals/board-a}"

# Pick a free port for the per-fixture dolt server so we don't collide with the
# operator's main server. Range 3400-3499 leaves room for multiple fixtures.
pick_port() {
  for p in $(seq 3400 3499); do
    if ! ss -lnt | awk '{print $4}' | grep -q ":${p}\$"; then
      echo "$p"
      return
    fi
  done
  echo "no free port in 3400-3499" >&2
  exit 1
}

# Tear down any prior fixture (stop server, wipe dir).
if [ -d "$BOARD_DIR/.beads" ]; then
  (cd "$BOARD_DIR" && bd dolt stop 2>/dev/null || true)
fi
rm -rf "$BOARD_DIR"
mkdir -p "$BOARD_DIR"

cd "$BOARD_DIR"

PORT="$(pick_port)"
echo "Seeding fixture at $BOARD_DIR on dolt port $PORT" >&2

# Initialize a fresh beads workspace dedicated to this fixture.
bd init --prefix=fix --no-shared-server >/dev/null 2>&1 || bd init --prefix=fix >/dev/null
bd dolt set port "$PORT" >/dev/null 2>&1 || true

# Helper for creating issues and capturing IDs.
# bd create --json emits pretty-printed JSON, so use jq for robust extraction.
create_issue() {
  local title="$1"
  local desc="$2"
  local type="$3"
  local priority="$4"
  bd create --title="$title" --description="$desc" --type="$type" --priority="$priority" --json 2>/dev/null \
    | jq -r '.id'
}

# === Bug + feature on same surface: extension-loader.ts ===
BUG_LOADER=$(create_issue \
  "Extension loader silently drops corrupt manifest entries" \
  "extension-loader.ts skips entries without a valid manifest.json but emits no warning. Operators don't know why their extension didn't load." \
  bug 2)
FEAT_LOADER=$(create_issue \
  "Extension loader: support hot-reload on manifest change" \
  "Add a watcher to extension-loader.ts so changes to manifest.json trigger a reload without a CLI restart." \
  feature 1)

# === 2 near-duplicates ===
DUP_OLDER=$(create_issue \
  "Truncate long titles in status line" \
  "Long issue titles overflow the status line. Need to truncate with ellipsis at 60 chars." \
  task 3)
DUP_NEWER=$(create_issue \
  "Status line: ellipsize titles over 60 characters" \
  "The status line breaks layout when titles exceed ~60 chars. Apply ellipsis truncation in status-line-renderer.ts." \
  task 2)

# === 3 siblings on one cluster: hook-runner.ts ===
HOOK_A=$(create_issue \
  "hook-runner: support async hooks" \
  "hook-runner.ts only invokes sync callbacks. Add Promise-aware path." \
  task 2)
HOOK_B=$(create_issue \
  "hook-runner: emit timing telemetry per hook" \
  "Add per-hook duration metrics in hook-runner.ts for the PostToolUse pipeline." \
  task 2)
HOOK_C=$(create_issue \
  "hook-runner: graceful failure when hook script is missing" \
  "If a hook references a deleted script, hook-runner.ts throws. Catch + warn + continue." \
  task 2)

# === Test ↔ impl pair with no edge ===
IMPL_RETRY=$(create_issue \
  "Add exponential backoff to dolt-client reconnect" \
  "dolt-client.ts currently retries at 1s. Replace with capped exponential backoff." \
  task 2)
TEST_RETRY=$(create_issue \
  "Test: exponential backoff in dolt-client reconnect" \
  "Unit test for the new backoff in dolt-client.ts. Should validate jitter and cap." \
  task 2)

# === Spawned follow-up with no provenance edge ===
PARENT_AUTH=$(create_issue \
  "Refactor auth-middleware token cache" \
  "auth-middleware.ts token cache uses unbounded Map. Bound by LRU." \
  task 2)
FOLLOWUP_AUTH=$(create_issue \
  "auth-middleware: also revisit cache invalidation on logout" \
  "Spawned while reviewing auth-middleware.ts — logout doesn't clear cache. Should be linked to the LRU refactor task." \
  task 3)

# === Priority mismatch: P3 bug + P1 feature on same surface ===
BUG_LOW=$(create_issue \
  "CLI exits 0 on parse failure for --json output" \
  "cli/index.ts swallows JSON parse errors and exits 0. Should exit 1." \
  bug 3)
FEAT_HIGH=$(create_issue \
  "CLI: structured --json output for all commands" \
  "Extend cli/index.ts JSON support to every subcommand." \
  feature 1)

# === In-progress issue (skill must NOT mutate this without explicit OK) ===
INPROG=$(create_issue \
  "Migrate logger.ts to pino" \
  "Replace console-based logger with pino structured logging." \
  task 2)
bd update "$INPROG" --claim >/dev/null

# === A clean P2 task touching nothing in particular (control) ===
CONTROL=$(create_issue \
  "Update README badge URLs after repo rename" \
  "Repo was renamed last month; README still points to old slug." \
  task 3)

# === A CLOSED near-dup of one of the open hook-runner siblings.
# Exercises step 2c: closed-issue dedup search.
# The skill should notice that "hook-runner: async hooks" has been done before. ===
CLOSED_DUP=$(create_issue \
  "hook-runner: add async hook support (initial pass)" \
  "Initial implementation of Promise-aware hook invocation in hook-runner.ts. Landed last quarter." \
  task 2)
bd close "$CLOSED_DUP" --reason="Initial async support landed in v1.4. Re-opened scope tracked in fix-${HOOK_A}." >/dev/null 2>&1 || true

# Dump the seeded board summary for the eval prompt to reference.
{
  echo "# Seeded board: board-a"
  echo
  echo "Issues created:"
  bd list 2>/dev/null | sed 's/^/  /'
  echo
  echo "Detection patterns present:"
  echo "  - Bug + feature on extension-loader.ts ($BUG_LOADER, $FEAT_LOADER)"
  echo "  - Near-duplicates on status line ($DUP_OLDER, $DUP_NEWER)"
  echo "  - 3 siblings on hook-runner.ts ($HOOK_A, $HOOK_B, $HOOK_C)"
  echo "  - Test ↔ impl pair on dolt-client.ts ($IMPL_RETRY, $TEST_RETRY)"
  echo "  - Spawned follow-up on auth-middleware.ts ($PARENT_AUTH, $FOLLOWUP_AUTH)"
  echo "  - Priority mismatch on cli/index.ts ($BUG_LOW P3, $FEAT_HIGH P1)"
  echo "  - In-progress claim (do not mutate): $INPROG"
  echo "  - Control issue: $CONTROL"
  echo "  - Closed near-dup of $HOOK_A (async hooks): $CLOSED_DUP"
} > "$BOARD_DIR/SEEDED.md"

cat "$BOARD_DIR/SEEDED.md"
echo
echo "Fixture ready: cd $BOARD_DIR && bd list" >&2
