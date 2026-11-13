#!/usr/bin/env python3
"""Guard for the board-audit harness and the whole project-management pack: no private literals, locked
thresholds, and the facts still add up.

Run before every commit that touches the pack:
    python3 check.py

Checks:
1. Literal guard, over every file of the pack (the three skills, their scripts, references, workflows, SKILL.md
   files and PACK.json; compiled files and caches skipped):
   - code files (.py, .sh, .mjs) carry no scratch-cache path, user name or mail address: the harness runs from the
     skill, for whoever holds the board, not from one person's scratch directory;
   - no file names a customer instance: tenant, repository, operator, time zone, the customer's services and
     vendors (time-series store, exchange, feed handler), its Jira status words in Italian, its socket paths, or
     the retired vocabulary (the old board name, "programme"). Instance values are settings (references/setup.md).
   Exemption, one rule: a HISTORY CITATION IN A COMMENT. A match is allowed when its line is a code comment (the
   text before the match starts with `#` or `//` after indentation, or sits inside `<!-- ... -->`) and the same
   line cites when it happened, with a date (YYYY-MM-DD) or a ticket key (ABC-123). A docstring, a string
   literal, prose in a reference and a comment without a citation are all scanned.
2. Threshold lock (jevcal analog): the STALE-7d age is a provisional constant, fitted to single cases and never
   calibrated. If it changes, this guard fails until it is updated deliberately with a refit note in
   audit-harness.md. (Window bands are config only, `window_bands`; the pack holds no band to lock.)
3. Abstain phrasing guard: the judged workflow must keep the not_applicable-ONLY
   sentence, so the v3 flapping fix cannot regress silently.
4. facts.py --selftest exits 0. Network cases report SKIPPED, which is not a failure.
"""
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
PACK = HERE.parents[1]
# Built from pieces so this file does not match its own guard when the pack is grepped (check.py is skipped too).
FORBIDDEN = (r'/\.' + 'cache\\b', 'daw' + 'id', '@' + 'gmail')
# Customer-instance literals (regex, case-insensitive) over every file of the pack.
INSTANCE = ('daw' + 'id', '@' + 'gmail', 'jag' + 'ger', 'mer' + 'cury', 'market' + '-data', 'europe/' + 'berlin',
            'quest' + 'db', r'\b' + 'cme' + r'\b', 'glo' + 'bex', 'inges' + 'tor', 'uds:' + '/run', 'cc-' + 'socks',
            'tabel' + 'lone', 'program' + 'me',
            r'\b' + 'complet' + r'ata\b', r'\bda ' + 'complet' + r'are\b', r'\bin ' + 'cor' + r'so\b',
            r'\bbloc' + r'cato\b')
CODE_SUFFIXES = {'.py', '.sh', '.mjs'}
SKIP_SUFFIXES = {'.pyc'}
SKIP_DIRS = {'__pycache__', '.pytest_cache', '.claude'}
CITATION = re.compile(r'\b20\d\d-\d\d-\d\d\b|\b[A-Z][A-Z0-9]+-\d+\b')


def scanned():
    """(path, patterns): code files get every pattern, every other file of the pack the instance ones."""
    for path in sorted(PACK.rglob('*')):
        if not path.is_file() or path.suffix in SKIP_SUFFIXES or SKIP_DIRS & set(path.parts):
            continue
        if path.resolve() == pathlib.Path(__file__).resolve():
            continue
        yield path, (FORBIDDEN + INSTANCE) if path.suffix in CODE_SUFFIXES else INSTANCE


def history_citation(line, col):
    """True when the match at ``col`` sits in a comment of ``line`` that cites a date or a ticket key."""
    before = line[:col]
    stripped = before.lstrip()
    in_comment = (stripped.startswith(('#', '//')) or ' # ' in before or '  #' in before
                  or ('<!--' in before and '-->' not in before[before.rfind('<!--'):]))
    return in_comment and bool(CITATION.search(line))


def literal_problems():
    problems = []
    for path, patterns in scanned():
        text = path.read_text(errors='replace')
        lines = text.split('\n')
        for pattern in dict.fromkeys(patterns):
            for match in re.finditer(pattern, text, re.I):
                n = text.count('\n', 0, match.start())
                col = match.start() - (text.rfind('\n', 0, match.start()) + 1)
                if history_citation(lines[n], col):
                    continue
                problems.append(f'{path.relative_to(PACK)}:{n + 1}: literal {match.group(0)!r} is not allowed')
    return problems


def main():
    problems = literal_problems()
    if problems:
        print('LITERAL GUARD: FAIL')
        for item in problems:
            print('  ' + item)
    else:
        print('LITERAL GUARD: PASS (no cache path, user name, mail address or customer-instance literal in the pack)')

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
        print('THRESHOLD/ABSTAIN GUARD: PASS (STALE-7d locked, not_applicable-ONLY present)')

    return 0 if not problems and not lock_problems and result.returncode == 0 else 1


def threshold_lock():
    src = (HERE / 'facts.py').read_text()
    locked = ['mage >= 7', 'age >= 7']
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
