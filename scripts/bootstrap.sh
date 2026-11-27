#!/usr/bin/env bash
# XTRM bootstrap for a new machine (CORE-2810).
#
# This is only the entry point that exists before anything is installed. It
# needs git, node >= 24 and npm. It clones the core checkout when the machine
# has none, then hands over to the CLI's own install command, which owns the
# whole install story (machine runtimes, payloads, local checkouts, links):
#
#   node <core>/cli/dist/index.cjs install --from-checkouts "$@"
#
# Usage:
#   scripts/bootstrap.sh                # install / update everything
#   scripts/bootstrap.sh --check        # report drift, change nothing
#   scripts/bootstrap.sh --home <dir>   # rehearsal against a temporary home
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${XTRM_BOOTSTRAP_ROOT:-$HOME/dev}"
core_remote="${XTRM_BOOTSTRAP_CORE_REMOTE:-git@github.com:xtrm-dev/core.git}"

cli=""
if [ -f "$here/cli/dist/index.cjs" ]; then
  cli="$here/cli/dist/index.cjs"
elif [ -f "$root/core/cli/dist/index.cjs" ]; then
  cli="$root/core/cli/dist/index.cjs"
else
  if [ -d "$root/core" ]; then
    echo "bootstrap: $root/core exists but has no built CLI (cli/dist/index.cjs);" >&2
    echo "           build it there (cd $root/core/cli && npm install && npm run build) and re-run." >&2
    exit 2
  fi
  echo "bootstrap: cloning core into $root/core" >&2
  mkdir -p "$root"
  git clone --quiet "$core_remote" "$root/core"
  cli="$root/core/cli/dist/index.cjs"
fi

exec node "$cli" install --from-checkouts "$@"
