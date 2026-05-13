#!/usr/bin/env bash
# Run OSV against this branch and fail only on vulnerabilities newly introduced
# relative to the branch baseline. This keeps pre-existing dependency debt from
# blocking unrelated pushes; CI remains the full-repo authoritative scan.

set -euo pipefail

if ! command -v osv-scanner >/dev/null; then
    echo "osv-scanner not installed — skipping (CI covers it)"
    exit 0
fi

HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
HEAD_SHA=$(git rev-parse HEAD)

upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
BASE_REF=""
if [ -n "$upstream" ]; then
    BASE_REF="$upstream"
else
    for cand in origin/main origin/master main master; do
        git rev-parse --verify "$cand" >/dev/null 2>&1 || continue
        [ "$cand" = "$HEAD_BRANCH" ] && continue
        BASE_REF="$cand"
        break
    done
fi

[ -n "$BASE_REF" ] && git fetch "${BASE_REF%%/*}" "${BASE_REF#*/}" --quiet 2>/dev/null || true

BASE=""
if [ -n "$BASE_REF" ]; then
    BASE=$(git merge-base HEAD "$BASE_REF" 2>/dev/null || true)
fi
if [ -z "$BASE" ]; then
    BASE=$(git rev-list HEAD --max-count=50 | tail -1)
    if [ "$BASE" = "$HEAD_SHA" ]; then
        echo "[osv-diff] no usable baseline — running informational current scan"
        osv-scanner scan source --recursive ./ || true
        exit 0
    fi
fi

workdir=$(mktemp -d)
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

current_json="$workdir/current.json"
base_json="$workdir/base.json"
base_tree="$workdir/base-tree"
mkdir -p "$base_tree"

git archive "$BASE" | tar -x -C "$base_tree"

# OSV exits non-zero when vulnerabilities are found; JSON output is still valid.
osv-scanner scan source --format json --output "$current_json" --verbosity error --recursive ./ >/dev/null 2>&1 || true
(
    cd "$base_tree"
    osv-scanner scan source --format json --output "$base_json" --verbosity error --recursive ./ >/dev/null 2>&1 || true
)

python3 - "$current_json" "$base_json" "$(pwd)" "$base_tree" <<'PY'
import json
import os
import sys

current_path, base_path, current_root, base_root = sys.argv[1:5]


def normalize_source(source, root):
    if os.path.isabs(source):
        try:
            return os.path.relpath(source, root)
        except ValueError:
            return source
    return source


def load(path, root):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return set(), {}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    keys = set()
    details = {}
    for result in data.get("results", []):
        source = normalize_source(result.get("source", {}).get("path", ""), root)
        for pkg in result.get("packages", []):
            meta = pkg.get("package", {})
            name = meta.get("name", "?")
            version = meta.get("version", "?")
            ecosystem = meta.get("ecosystem", "?")
            for vuln in pkg.get("vulnerabilities", []):
                vuln_id = vuln.get("id") or vuln.get("database_specific", {}).get("source") or "?"
                key = (vuln_id, ecosystem, name, version, source)
                keys.add(key)
                details[key] = f"{vuln_id} {ecosystem} {name}@{version} ({source})"
    return keys, details

current, current_details = load(current_path, current_root)
base, _ = load(base_path, base_root)
new = sorted(current - base)
if not new:
    print("osv-diff: no new vulnerabilities vs baseline")
    raise SystemExit(0)
print(f"osv-diff: {len(new)} new vulnerabilit(y/ies) vs baseline", file=sys.stderr)
for key in new:
    print("  - " + current_details[key], file=sys.stderr)
raise SystemExit(1)
PY
