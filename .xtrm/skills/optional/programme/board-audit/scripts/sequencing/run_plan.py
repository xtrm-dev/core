#!/usr/bin/env python3
"""Load-gated driver for the programme-sequencing workflows. One AgentRun per chunk of at most 40 rows.

  python3 run_plan.py --node pairs --rows run/rows-pairs.json --out runs/pairs-pilot-1 [--pilot 15] [--chunk 40]

Writes <out>/input-NN.json, <out>/run-NN.json and <out>/MANIFEST.json (workflow sha, rubric sha, input sha, per-chunk status).
Refuses to start while another AgentRun is live or the load gate fails (load1 <= 10, memory PSI full avg10 <= 10).
If AgentRun fails the driver stops and prints the exact command and error; it never falls back to per-item calls.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
LOAD_MAX, PSI_MAX, WAIT_MAX = 10.0, 10.0, 300


def sha(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode()).hexdigest()[:16]


def load1():
    return float(pathlib.Path('/proc/loadavg').read_text().split()[0])


def psi_full():
    m = re.search(r'full avg10=([\d.]+)', pathlib.Path('/proc/pressure/memory').read_text())
    return float(m.group(1)) if m else 0.0


def live_agentrun():
    out = subprocess.run(['ps', '-eo', 'pid,args'], capture_output=True, text=True).stdout.splitlines()
    mine = str(os.getpid())
    return [l.strip() for l in out if re.search(r'agentrun-pi/dist/cli\.js run', l) and not l.strip().startswith(mine + ' ')]


def gate():
    t0 = time.time()
    while True:
        l, p, live = load1(), psi_full(), live_agentrun()
        if l <= LOAD_MAX and p <= PSI_MAX and not live:
            return l, p
        if time.time() - t0 > WAIT_MAX:
            raise SystemExit(f'GATE: waited {WAIT_MAX}s: load1={l} psi_full_avg10={p} live_agentrun={live[:2]}')
        time.sleep(20)


def pilot_pick(rows, n):
    by = {}
    for r in sorted(rows, key=lambda r: r['key']):
        by.setdefault(r['oracle'].split('|')[0], []).append(r)
    out, i = [], 0
    while len(out) < n and any(by.values()):
        for k in sorted(by):
            if by[k] and len(out) < n:
                bucket = by[k]
                out.append(bucket.pop(len(bucket) // 2 if i % 2 else 0))
        i += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--node', required=True, choices=['bundles', 'pairs', 'items', 'days'])
    ap.add_argument('--rows', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--pilot', type=int, default=0)
    ap.add_argument('--keys', default='', help='comma list of row keys to run (overrides --pilot)')
    ap.add_argument('--chunk', type=int, default=40)
    a = ap.parse_args()
    root = os.environ.get('AGENTRUN_PI_ROOT') or subprocess.run(['npm', 'root', '-g'], capture_output=True, text=True).stdout.strip() + '/@parcha/agentrun-pi'
    cli = pathlib.Path(root) / 'dist' / 'cli.js'
    wf = HERE / 'workflows' / f'programme-seq-{a.node}-v1.json'
    rubric = json.loads((HERE / 'rubrics.json').read_text())[a.node]
    rows = json.loads(pathlib.Path(a.rows).read_text())
    if a.keys:
        want = a.keys.split(',')
        rows = [r for r in rows if r['key'] in want]
    elif a.pilot:
        rows = pilot_pick(rows, a.pilot)
    out = pathlib.Path(a.out)
    if any(out.glob('input-*.json')) or any(out.glob('run-*.json')):
        raise SystemExit(f'REFUSED: {out} already holds chunk files from an earlier (possibly stopped) run; aggregate and build_plan read every chunk file in a run directory. Remove it or choose a new --out.')
    out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, AGENTRUN_PI_ROOT=root, PI_MODELS_PATH=os.environ.get('PI_MODELS_PATH', str(pathlib.Path.home() / '.pi/agent/models.json')),
               PI_MODELS_STORE_PATH=str(HERE / 'models-store.json'))
    chunks = [rows[i:i + a.chunk] for i in range(0, len(rows), a.chunk)]
    manifest = {'node': a.node, 'workflow_sha': sha(wf.read_text()), 'rubric_sha': sha(rubric), 'rows': len(rows), 'chunks': []}
    for n, chunk in enumerate(chunks, 1):
        l, p = gate()
        inp = out / f'input-{n:02d}.json'
        inp.write_text(json.dumps({'batch_id': f'{a.node}-{n:02d}', 'rubric': rubric, 'rows': chunk}, indent=1))
        cmd = ['node', str(cli), 'run', '--config', str(HERE / 'agentrun-config.mjs'), str(wf), str(inp)]
        for attempt in (1, 2):
            t0 = time.time()
            proc = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=HERE)
            try:
                d = json.loads(proc.stdout)
            except Exception:
                d = {'status': 'parse_error'}
            got = len(d.get('output') or [])
            ok = d.get('status') == 'complete' and got == len(chunk)
            if ok or attempt == 2:
                break
            # One identical retry of the same AgentRun command; the first failure is kept verbatim for the report.
            (out / f'run-{n:02d}.attempt1.err').write_text('command: ' + ' '.join(cmd) + '\nstatus: ' + str(d.get('status')) + '\nstderr: ' + proc.stderr[-1500:] + '\nstdout: ' + (proc.stdout or '')[:800] + '\n')
            print(f"{a.node} chunk {n}: attempt 1 failed ({d.get('status')}): {proc.stderr[-160:].strip()!r}; retrying the same command once", flush=True)
            l, p = gate()
        (out / f'run-{n:02d}.json').write_text(proc.stdout or '')
        manifest['chunks'].append({'n': n, 'rows': len(chunk), 'status': d.get('status'), 'verdicts': got, 'input_sha': sha(inp.read_text()),
                                   'seconds': round(time.time() - t0), 'load1': l, 'psi': p, 'attempts': attempt})
        print(f"{a.node} chunk {n}/{len(chunks)} status={d.get('status')} verdicts={got}/{len(chunk)} {time.time() - t0:.0f}s load1={l} attempts={attempt}", flush=True)
        if not ok:
            (out / 'MANIFEST.json').write_text(json.dumps(manifest, indent=1))
            sys.stderr.write('AGENTRUN FAILED\ncommand: ' + ' '.join(cmd) + '\nstatus: ' + str(d.get('status')) + '\nerror: ' + json.dumps(d.get('error') or d, default=str)[:1500] + '\nstderr: ' + proc.stderr[-800:] + '\n')
            raise SystemExit(3)
    (out / 'MANIFEST.json').write_text(json.dumps(manifest, indent=1))


if __name__ == '__main__':
    main()
