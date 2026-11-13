#!/usr/bin/env python3
"""Read a Substrate journal entry's payload wherever it actually lives.

WHY THIS EXISTS. Three times in two days I called an entry empty because I read only one field:

  * one entry, seq 3 — the payload was in `result`, so I told the operator that an
    investigation had not run. It had run. (2026-11-04.)
  * another, seq 11 — a fully verified success whose numbers were in `result.summary`,
    invisible to the drift instrument, which reads semantic text only.
  * a third, seq 4 — the 23,524-char audit text sat in `semantic.summary`; I read
    `semantic.text`, saw nothing, and appended a duplicate as seq 5. (2026-11-06.)

The lesson is the same each time and it is not about Substrate being odd: an entry has
several places to keep its payload, and "empty" is a claim about all of them at once.
So this helper checks every known place, in a fixed order, and REPORTS which field it
used — a reader that cannot say where it found the text cannot be trusted when it says
there is none.

Order: semantic.text, semantic.summary, semantic.body, result.summary, mechanical.
The first non-empty candidate wins; `entry_payload` returns (text, field_name) so a
caller can print the provenance instead of guessing.

Usage (import):
    from sbtext import entries, entry_payload
    for e in entries("SB-4080"):
        text, where = entry_payload(e)
        print(e.get("sequence"), where, len(text))

Usage (CLI):
    python3 sbtext.py SB-4080          # one line per entry: seq, kind, field, length
    python3 sbtext.py SB-4080 4        # the full payload of seq 4, to stdout
"""
import json
import subprocess
import sys

import lanecfg  # noqa: E402

SB = lanecfg.sb_bin()
FIELDS = (("semantic", "text"), ("semantic", "summary"), ("semantic", "body"),
          ("result", "summary"), ("mechanical", None))


def entries(ref, limit=100):
    out = subprocess.run([SB, "journal", "show", ref, "--limit", str(limit), "--json"],
                         capture_output=True, text=True, timeout=120)
    try:
        d = json.loads(out.stdout)
    except Exception:
        return []
    rows = d.get("data")
    return rows if isinstance(rows, list) else []


def _flat(v):
    """JSON value -> string, without pretending to know its inner shape."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False)


def entry_payload(entry):
    """Return (text, field_name) for the first non-empty payload field, else ("", "empty")."""
    for block, key in FIELDS:
        v = entry.get(block)
        if v is None:
            continue
        text = _flat(v if key is None else (v.get(key) if isinstance(v, dict) else v))
        if text and text not in ("null", "{}", "[]"):
            return text, block + ("." + key if key else "")
    return "", "empty"


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    ref = argv[1]
    es = entries(ref)
    if not es:
        print(f"{ref}: no entries readable")
        return 1
    if len(argv) > 2:
        want = int(argv[2])
        for e in es:
            if e.get("sequence") == want:
                text, where = entry_payload(e)
                print(f"# {ref} seq {want} kind={e.get('kind')} field={where} len={len(text)}",
                      file=sys.stderr)
                sys.stdout.write(text)
                return 0
        print(f"{ref}: no sequence {want}", file=sys.stderr)
        return 1
    for e in es:
        text, where = entry_payload(e)
        print(f"{e.get('sequence'):>3} {str(e.get('kind')):<10} {where:<18} len={len(text)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
