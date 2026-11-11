#!/bin/sh
# Rebuild dist/worker.mjs from worker/worker.ts and the shared TS library. Run after any change to either.
set -eu
cd "$(dirname "$0")/.."
bun build worker/worker.ts --target=node --outfile dist/worker.mjs
