#!/usr/bin/env bash
# XTRM local-checkout bootstrap (CORE-2810) — thin wrapper around bootstrap.mjs.
# Runs with the Node that is on PATH; core requires Node >= 24.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/bootstrap.mjs" "$@"
