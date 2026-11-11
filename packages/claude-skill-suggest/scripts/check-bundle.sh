#!/bin/sh
# Parity: the committed dist/worker.mjs must equal a fresh build; and its imports must be node builtins only.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
bun build worker/worker.ts --target=node --outfile "$tmp/worker.mjs" >/dev/null
cmp -s dist/worker.mjs "$tmp/worker.mjs" || { echo "dist/worker.mjs is stale: run scripts/build.sh" >&2; exit 1; }
bad=$(grep -E "^import .* from ['\"]" dist/worker.mjs | sed -E "s/.* from ['\"]([^'\"]+)['\"].*/\1/" | grep -v '^node:' || true)
[ -z "$bad" ] || { echo "non-builtin imports in the bundle: $bad" >&2; exit 1; }
echo "bundle parity ok ($(wc -c < dist/worker.mjs) bytes, node builtins only)"
