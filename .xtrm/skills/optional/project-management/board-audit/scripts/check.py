#!/usr/bin/env python3
"""Guard for the board-audit harness: no private literals, locked thresholds, and the facts still add up.

Run before every commit that touches scripts/ or workflows/:
    python3 check.py

Three checks:
1. No file in this directory carries a cache path, a user name or a mail address.
   The harness must run from the skill, for whoever holds the board, not from one
   person's scratch directory.
2. Threshold lock (jevcal analog): the STALE-7d age and the CME halt band are
   provisional constants, fitted to single cases and never calibrated. If any of
   them changes, this guard fails until it is updated deliberately with a refit
   note in audit-harness.md.
3. Abstain phrasing guard: the judged workflow must keep the not_applicable-ONLY
   sentence, so the v3 flapping fix cannot regress silently.
4. facts.py --selftest exits 0. Network cases report SKIPPED, which is not a failure.
"""
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
# Built from pieces so this file does not match its own guard when the directory is grepped.
FORBIDDEN = ('.' + 'cache', 'daw' + 'id', '@' + 'gmail')
SKIP_SUFFIXES = {'.pyc'}


def main():
    problems = []
    for path in sorted(HERE.rglob('*')):
        if not path.is_file() or path.suffix in SKIP_SUFFIXES:
            continue
        if path.name == 'check.py':
            continue
        text = path.read_text(errors='replace')
        for pattern in FORBIDDEN:
            for match in re.finditer(re.escape(pattern), text):
                line = text[:match.start()].count('\n') + 1
                problems.append(f'{path.name}:{line}: literal {pattern!r} is not allowed')

    if problems:
        print('LITERAL GUARD: FAIL')
        for item in problems:
            print('  ' + item)
    else:
        print('LITERAL GUARD: PASS (no cache path, user name or mail address in scripts/)')

    result = subprocess.run([sys.executable, str(HERE / 'facts.py'), '--selftest'],
                            capture_output=True, text=True)
    tail = [line for line in result.stdout.splitlines() if line.startswith(('PASS', 'SKIP', 'FAIL'))]
    skipped = sum(1 for line in tail if line.startswith('SKIP'))
    failed = [line for line in tail if line.startswith('FAIL')]
    print(f'SELFTEST: {"PASS" if result.returncode == 0 and not failed else "FAIL"} '
          f'({len(tail) - skipped} checks run, {skipped} skipped)')
    for line in failed:
        print('  ' + line)
    if result.returncode != 0:
        print(result.stdout[-1200:])

    lock_problems = threshold_lock() + abstain_phrasing()
    for item in lock_problems:
        print('  ' + item)
    if lock_problems:
        print('THRESHOLD/ABSTAIN GUARD: FAIL')
    else:
        print('THRESHOLD/ABSTAIN GUARD: PASS (STALE-7d + halt band locked, not_applicable-ONLY present)')

    return 0 if not problems and not lock_problems and result.returncode == 0 else 1


def threshold_lock():
    src = (HERE / 'facts.py').read_text()
    locked = ['mage >= 7', 'age >= 7', "INGESTOR_HALT_UTC = ('21:17', '21:55')"]
    missing = [item for item in locked if item not in src]
    if not missing:
        return []
    return ([f'threshold changed without refit: {item!r} no longer in facts.py.'] + missing
            + ['Record the refit in audit-harness.md, then update this guard deliberately.'])


def abstain_phrasing():
    workflow = (HERE.parent / 'workflows' / 'board-batch-verdicts-v3.json').read_text()
    if 'not_applicable ONLY' in workflow:
        return []
    return ['abstain phrasing lost: not_applicable-ONLY sentence missing from '
            'workflows/board-batch-verdicts-v3.json.']


if __name__ == '__main__':
    sys.exit(main())
