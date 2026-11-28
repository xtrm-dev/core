#!/usr/bin/env bash
# XTRM bootstrap for a new machine (CORE-2810).
#
# This is only the entry point that exists before anything is installed. It
# needs git, node >= 24 and npm. It clones the core checkout when the machine
# has none, then hands over to the CLI's own update command, which owns the
# install story (machine runtimes, payloads, local checkouts, links). There is
# deliberately no `xt install`: the root command surface is guarded by
# cli/test/install-surface.test.ts, so the checkout phase lives on `xt update`
# (routine) and `xt init` (first install), with `xt doctor` reporting it.
#
#   node <core>/cli/dist/index.cjs update --from-checkouts "$@"
#
# Usage:
#   scripts/bootstrap.sh                # clone/fast-forward, install, link, report
#   scripts/bootstrap.sh --apply        # same, with the registry writes forced
#   scripts/bootstrap.sh --json         # machine-readable report
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

# Anchor the run in the core checkout: the phase resolves `core` from the
# project it stands in, and a run from ~/dev (or from a foreign repository)
# would otherwise treat that directory as the core checkout and install there.
cd "$root/core" || exit 2

exec node "$cli" update --from-checkouts "$@"
