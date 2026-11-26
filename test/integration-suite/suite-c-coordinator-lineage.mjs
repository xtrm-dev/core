// Suite C — coordinator-lineage conformance (audit §P2-01 steps 2-5, 7-11).
//
// GRADUATED from the BLOCKED probe stub by xtrm-6hey0 (audit P0-05 `--subordinate`
// + P1-02 lineage metadata). This is the live, capability-gated lane the stub
// promised: it launches a real subordinate chain coordinator through the packed
// Core artifact and asserts the lineage invariants on the resulting pane.
//
//   node test/integration-suite/suite-c-coordinator-lineage.mjs <core.tgz>
//
// ── Isolation ───────────────────────────────────────────────────────────────
// Private tmux server (`tmux -L`), isolated HOME/XDG_STATE_HOME/TMUX_TMPDIR, and
// a throwaway git repo. The operator's live tmux server, real worktrees and
// 300MB observability.db are never touched. Same discipline as Suite B.
//
// ── What is faithful, and what is shimmed (declared, not hidden) ────────────
// • Core is the REAL packed artifact — `xt` runs from cli/dist/index.cjs of the
//   tarball under test. Every assertion below is against that binary.
// • `sp` and the runtime binary (`claude`) are SHIMS in the default lane. Suite
//   C's subject is *Core's* lineage contract — which worktree, branch, parent,
//   role and bead a launch publishes — not Specialists' task rendering (Suite A
//   asserts the installed Specialists artifact at contract level) and not a real
//   LLM turn. Shimming them is what makes steps 2-5 and 11 assertable at all: a
//   real `sp render-task` needs a beads database, and a real agent needs an API
//   key.
// • Steps 7-10 dispatch an actual specialist chain and inspect its branches.
//   They stay SKIP unless the live lane is opted into (see below), because they
//   need a real `sp`, a real beads database and real model credentials.
//
// ── Opt-in live lane (XTRM_SUITE_C_LIVE=1) ──────────────────────────────────
// With the gate set, `sp` is NOT shimmed and steps 7-10 run for real:
//   7  dispatch a specialist from the coordinator's own tmux session + worktree
//   8  git merge-base --is-ancestor <coordinator-branch> <sp-branch>
//   9  the job's xtrm.runtime-origin.v1 spawn origin points at the sandbox
//      coordinator session, not at the operator's real pane
//  10  merge the accepted specialist branch back into the coordinator branch
// Isolation is unchanged: private tmux server, sandbox HOME/XDG_STATE_HOME,
// throwaway repo. Model credentials are COPIED out of the operator's
// ~/.pi/agent into the sandbox (read-only source, never written back). The gate
// costs an API-billed agent turn, so it is a pre-release lane, never per-PR CI.
// A missing prerequisite (no sp, no bd, no credentials) SKIPs with the concrete
// reason instead of failing — absence of an API key is not a conformance bug.
//
// Exit code is 0 when the capability gate closes (no tmux / no git / no core
// tarball); non-zero only on a genuine conformance failure.

import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSuccess, makeSandbox, reporter, run } from './lib/harness.mjs';

const r = reporter('suite-c');
const SOCKET = `p201c-${process.pid}`;
const BEAD = 'xtrm-6hey0';
const SLUG = 'coord';

// Opt-in: steps 7-10 dispatch a real, API-billed specialist. Off by default.
const LIVE = process.env.XTRM_SUITE_C_LIVE === '1';
// Cheapest chain that still provisions a worktree: a READ_ONLY specialist with
// --worktree forced. The subject is branch topology, not agent quality.
const LIVE_SPECIALIST = process.env.XTRM_SUITE_C_LIVE_SPECIALIST || 'explorer';
// Credential/model files copied out of the operator's pi agent dir. Read-only
// source: the sandbox gets copies and the originals are never written.
const PI_AGENT_FILES = ['auth.json', 'models.json', 'settings.json'];

const STEP_7 = 'step 7: dispatch a specialist child from the coordinator';
const STEP_8 = 'step 8: verify specialist branch derives from coordinator branch';
const STEP_9 = 'step 9: verify descendant runtime-origin lineage';
const STEP_10 = 'step 10: merge accepted specialist branch into coordinator branch';

// Steps the hermetic lane cannot honestly assert without live agents. Kept
// explicit so the ledger shows what is uncovered instead of silently omitting it.
const LIVE_ONLY = [
  [STEP_7, 'needs a live specialist chain (real agent + API credentials) — set XTRM_SUITE_C_LIVE=1'],
  [STEP_8, 'sp creates specialist branches; Core only publishes the base via @agent_branch (audit P1-03)'],
  [STEP_9, 'runtime-origin propagation is Specialists-side (SupervisorStatus), needs a dispatched job'],
  [STEP_10, 'needs step 7-8 branches to exist'],
];

function which(bin) {
  const res = run('sh', ['-c', `command -v ${bin} || true`]);
  const p = res.stdout.trim();
  return p && existsSync(p) ? p : null;
}

const TMUX = which('tmux');
const GIT = which('git');
// Resolved before the sandbox PATH shims exist, so these are the operator's
// real binaries and never the `sp` shim written under box.root/bin.
const SP = which('sp');
const BD = which('bd');
// Specialists captures xtrm.runtime-origin.v1 by shelling out to
// `xtmux context --current --json`, so step 9 is only assertable when the
// dispatching shell can resolve xtmux.
const XTMUX = which('xtmux');
const coreTgz = process.argv[2] || process.env.P201_CORE_TARBALL;

// ── capability gate ─────────────────────────────────────────────────────────
if (!TMUX || !GIT || !coreTgz || !existsSync(coreTgz)) {
  const missing = [!TMUX && 'tmux', !GIT && 'git', (!coreTgz || !existsSync(coreTgz)) && 'core tarball'].filter(Boolean).join(' + ');
  for (const s of ['step 2-5, 11 (coordinator lineage)']) r.skip(s, `lineage runtime unavailable (missing ${missing})`);
  for (const [s, why] of LIVE_ONLY) r.skip(s, why);
  r.summary();
  console.log('suite-c: SKIP (no lineage runtime)');
  process.exit(0);
}

const box = makeSandbox('xtrm-p201-c-');
const { project, installPrefix, tmuxTmp } = box;
const env = { ...box.env, TMUX_TMPDIR: tmuxTmp };
const tmux = (...args) => run(TMUX, ['-L', SOCKET, ...args], { env });
const git = (cwd, ...args) => run(GIT, args, { cwd, env });

function sleepMs(ms) {
  run('sh', ['-c', `sleep ${ms / 1000}`]);
}

// Prepended to every pane command. tmux's `-e PATH=…` does NOT survive into the
// pane: tmux runs the pane shell as a login shell, which re-sources the
// profile and rebuilds PATH from scratch. Exporting inside the command is the
// only placement the profile cannot undo — without it the pane silently
// resolves the operator's REAL `sp`/`claude` instead of the sandbox shims.
let panePathPrefix = '';

// Run a command inside a live pane so Core sees a real $TMUX and a real parent
// session. Output is captured through a sentinel file and polled — no reliance
// on prompt timing. Same technique as Suite B's paneRun.
function paneRun(paneId, tag, shellCmd, tries = 160) {
  const outFile = path.join(box.root, `${tag}.out`);
  const doneFile = path.join(box.root, `${tag}.done`);
  rmSync(outFile, { force: true });
  rmSync(doneFile, { force: true });
  tmux('send-keys', '-t', paneId, `{ ${panePathPrefix}${shellCmd} ; } > ${outFile} 2>&1; echo $? > ${doneFile}`, 'Enter');
  for (let i = 0; i < tries; i++) {
    if (existsSync(doneFile)) {
      return {
        rc: parseInt(readFileSync(doneFile, 'utf8').trim(), 10),
        out: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '',
      };
    }
    sleepMs(125);
  }
  throw new Error(`paneRun(${tag}) timed out`);
}

const paneOption = (paneId, key) =>
  tmux('show-options', '-p', '-t', paneId, '-qv', key).stdout.trim();

function writeShim(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

// ── live lane helpers ───────────────────────────────────────────────────────

// Every sandbox binding a pane needs, exported inside the command for the same
// reason panePathPrefix is: tmux re-sources the profile for the pane shell, so
// `-e` on the session does not survive for PATH-like vars. XTMUX_AGENT_* is
// deliberately NOT exported here — inheriting it from the coordinator session
// is the Core-side half of P1-03 and step 7 asserts it rather than staging it.
function sandboxExports() {
  const exports = [
    ['HOME', box.home],
    ['XDG_STATE_HOME', box.state],
    ['XDG_CONFIG_HOME', path.join(box.home, '.config')],
    ['XDG_DATA_HOME', path.join(box.home, '.local', 'share')],
    ['PI_AGENT_DIR', box.piAgentDir],
  ].map(([k, v]) => `export ${k}="${v}"; `).join('');
  // xtmux must be resolvable: it is how Specialists captures the runtime
  // origin (step 9). The sandbox HOME has no profile, so the pane's login
  // shell rebuilds a PATH that would not otherwise contain it.
  return `${exports}export PATH="${path.dirname(XTMUX)}:$PATH"; `;
}

// Copy the operator's model registry + credentials + per-specialist model
// overrides into the sandbox. Source is read only; the sandbox owns the copies,
// so a live run can never write back into the operator's real config.
function seedCredentials() {
  const piSrc = path.join(os.homedir(), '.pi', 'agent');
  const missing = PI_AGENT_FILES.filter((f) => !existsSync(path.join(piSrc, f)));
  if (missing.length) return `missing pi credentials: ${missing.join(', ')} in ${piSrc}`;
  for (const f of PI_AGENT_FILES) copyFileSync(path.join(piSrc, f), path.join(box.piAgentDir, f));

  // Per-specialist model overrides. Without them `sp run` refuses with
  // "specialist has no model configured".
  const spUser = path.join(os.homedir(), '.config', 'specialists', 'user.json');
  if (!existsSync(spUser)) return `missing specialist model config: ${spUser}`;
  const spDest = path.join(box.home, '.config', 'specialists');
  mkdirSync(spDest, { recursive: true });
  copyFileSync(spUser, path.join(spDest, 'user.json'));
  return null;
}

// The dispatched job as Specialists records it. Terminal jobs are included:
// the lane asserts branch topology and origin, not that the agent finished.
function findJob(beadId) {
  const res = run(SP, ['ps', '--json', '--include-terminal'], { cwd: project, env });
  if (res.status !== 0) return null;
  try {
    const jobs = JSON.parse(res.stdout).flat ?? [];
    return jobs.find((j) => j.bead_id === beadId && j.branch) ?? null;
  } catch {
    return null;
  }
}

let exitCode = 0;
try {
  // ── fixture: packed Core + shimmed sp/runtime on an isolated PATH ──────────
  const installed = run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save',
    '--prefix', installPrefix, coreTgz,
  ], { cwd: project, env });
  assert.equal(installed.status, 0, `core install failed: ${installed.stderr.slice(-800)}`);

  const cli = path.join(installPrefix, 'node_modules', 'xtrm-tools', 'cli', 'dist', 'index.cjs');
  assert.ok(existsSync(cli), 'core: cli/dist/index.cjs missing from packed install');

  const bin = path.join(box.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeShim(bin, 'xt', `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  // Runtime shim: stays alive so the pane (and its @agent_* options) survives
  // long enough to be inspected. Args are irrelevant — Core's contract here is
  // the metadata it writes, not what the agent does with the prompt.
  writeShim(bin, 'claude', '#!/bin/sh\nexec sleep 120\n');
  // sp shim: answers the three sub-commands the role launch path calls. The
  // JSON mirrors the real chain-coordinator envelope's shape (P1-01). The shim
  // stays in place even in the live lane so steps 2-5 are byte-identical across
  // both: the live lane dispatches the REAL sp by absolute path (SP_BIN), so
  // Core's launch path and Specialists' dispatch path never share a resolution.
  writeShim(bin, 'sp', [
    '#!/bin/sh',
    'case "$1" in',
    '  view) printf \'%s\\n\' \'{"specialist":{"metadata":{"name":"chain-coordinator"},"execution":{"interactive":true},"prompt":{"system":"You coordinate one epic."},"skills":{"paths":[]}}}\' ;;',
    '  render-skill-prefix) exit 1 ;;',
    `  render-task) printf '%s\\n' '{"ok":true,"initial_prompt":"Coordinate ${BEAD}.","prompt_hash":"suite-c-fixture","components":[]}' ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n') + '\n');
  panePathPrefix = `export PATH="${bin}:$PATH"; `;

  // Throwaway git repo standing in for the operator's main checkout.
  mkdirSync(project, { recursive: true });
  assert.equal(git(project, 'init', '-b', 'main').status, 0, 'git init failed');
  git(project, 'config', 'user.email', 'suite-c@example.invalid');
  git(project, 'config', 'user.name', 'suite-c');
  writeFileSync(path.join(project, 'README.md'), '# suite-c fixture\n');
  // Mirror a real xtrm repo: the worktree roots are ignored, so step 11's
  // porcelain check stays meaningful (it catches real edits to main's tree
  // rather than tripping over the coordinator's or a specialist's own worktree
  // directory). `.worktrees/` is where Specialists provisions its own.
  writeFileSync(path.join(project, '.gitignore'), '.xtrm/\n.worktrees/\n');
  git(project, 'add', '-A');
  assert.equal(git(project, 'commit', '-m', 'fixture').status, 0, 'fixture commit failed');
  const mainShaBefore = git(project, 'rev-parse', 'main').stdout.trim();
  assert.ok(mainShaBefore, 'could not resolve fixture main sha');

  // ── STEP 2: launch main orchestrator from the main worktree ───────────────
  const started = tmux(
    'new-session', '-d', '-s', 'orch', '-x', '200', '-y', '50', '-c', project,
    '-e', `XDG_STATE_HOME=${box.state}`, '-e', `TMUX_TMPDIR=${tmuxTmp}`,
    '-e', `HOME=${box.home}`, 'sh',
  );
  assert.equal(started.status, 0, `tmux new-session orch failed: ${started.stderr}`);
  const orchPane = tmux('list-panes', '-t', 'orch', '-F', '#{pane_id}').stdout.trim();
  const orchSession = tmux('display-message', '-p', '-t', 'orch', '#{session_id}').stdout.trim();
  assert.ok(orchPane && orchSession, 'could not resolve orchestrator pane/session');
  const orchCwd = tmux('display-message', '-p', '-t', orchPane, '#{pane_current_path}').stdout.trim();
  // The orchestrator sits in the MAIN worktree — the invariant P1-02 names.
  assert.ok(!orchCwd.includes(path.join('.xtrm', 'worktrees')), `orchestrator is not in the main worktree: ${orchCwd}`);
  r.ok('step 2: launch main orchestrator from main worktree', `${orchSession} @ ${orchCwd}`);

  // ── STEP 3: launch subordinate chain coordinator through Core ─────────────
  const launch = paneRun(
    orchPane, 'launch',
    `xt claude ${SLUG} --role chain-coordinator --bead ${BEAD} --subordinate`,
  );
  assert.equal(launch.rc, 0, `xt --subordinate failed (rc=${launch.rc}):\n${launch.out.slice(-2000)}`);

  // --no-attach stdout contract: exactly one `session_name:pane_id` line, even
  // though the human-facing launcher chatter shares the same stream.
  const coordLine = launch.out.split('\n').map((l) => l.trim())
    .filter((l) => /^role-claude-chain-coordinator[\w.-]*:%\d+$/.test(l));
  assert.equal(coordLine.length, 1, `expected exactly one session:pane line, got ${coordLine.length}:\n${launch.out.slice(-2000)}`);
  const [coordSessionName, coordPane] = coordLine[0].split(':');
  // The orchestrator's own pane was NOT hijacked — the whole point of P0-05.
  assert.notEqual(coordPane, orchPane, '--subordinate ran in the orchestrator pane');
  assert.equal(paneOption(orchPane, '@agent_role'), '', 'orchestrator pane acquired coordinator metadata');
  r.ok('step 3: launch subordinate chain coordinator through Core', coordLine[0]);

  // ── STEP 4: verify distinct coordinator worktree and branch ───────────────
  const coordWorktree = paneOption(coordPane, '@agent_worktree');
  const coordBranch = paneOption(coordPane, '@agent_branch');
  assert.ok(coordWorktree && existsSync(coordWorktree), `@agent_worktree missing or absent on disk: ${coordWorktree}`);
  assert.ok(
    coordWorktree.startsWith(path.join(project, '.xtrm', 'worktrees') + path.sep),
    `coordinator worktree is not under the repo's worktree root: ${coordWorktree}`,
  );
  assert.notEqual(coordWorktree, project, 'coordinator is using the main worktree');
  const headBranch = git(coordWorktree, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  assert.equal(headBranch, coordBranch, `@agent_branch (${coordBranch}) disagrees with the checked-out branch (${headBranch})`);
  assert.notEqual(headBranch, 'main', 'coordinator branch is not distinct from main');
  r.ok('step 4: verify distinct coordinator worktree and branch', `${coordBranch} @ ${coordWorktree}`);

  // ── STEP 5: verify parent session, role and bead pane metadata ────────────
  assert.equal(paneOption(coordPane, '@agent_parent_session'), orchSession, '@agent_parent_session does not point at the orchestrator');
  assert.equal(paneOption(coordPane, '@agent_role'), 'chain-coordinator', '@agent_role missing or wrong');
  assert.equal(paneOption(coordPane, '@agent_issue'), BEAD, '@agent_issue missing or wrong');
  assert.equal(paneOption(coordPane, '@agent_bead'), '', 'the legacy @agent_bead is never written (CORE-2801)');
  assert.equal(paneOption(coordPane, '@agent_task'), 'role:chain-coordinator', '@agent_task missing or wrong');
  assert.equal(paneOption(coordPane, '@agent_state'), 'idle', '@agent_state not primed to idle');
  r.ok('step 5: verify parent session, role and bead pane metadata', `parent=${orchSession} role=chain-coordinator bead=${BEAD}`);

  // ── STEPS 7-10: live specialist chain ─────────────────────────────────────
  if (!LIVE) {
    for (const [s, why] of LIVE_ONLY) r.skip(s, why);
  } else if (!SP || !BD || !XTMUX) {
    const why = `live lane needs ${[!SP && 'sp', !BD && 'bd', !XTMUX && 'xtmux'].filter(Boolean).join(' + ')} on PATH`;
    for (const [s] of LIVE_ONLY) r.skip(s, why);
  } else {
    const credError = seedCredentials();
    if (credError) {
      for (const [s] of LIVE_ONLY) r.skip(s, `live lane unavailable: ${credError}`);
    } else {
      // The coordinator does a unit of its own work first. Without a commit
      // that main does not have, step 8's ancestry assertion would hold
      // trivially — both branches would still point at the fixture commit.
      writeFileSync(path.join(coordWorktree, 'COORDINATOR.md'), '# coordinator work\n');
      assert.equal(git(coordWorktree, 'add', '-A').status, 0, 'coordinator stage failed');
      assert.equal(
        git(coordWorktree, 'commit', '-m', 'coordinator: integration base').status, 0,
        'coordinator commit failed',
      );
      const coordSha = git(coordWorktree, 'rev-parse', 'HEAD').stdout.trim();
      assert.notEqual(coordSha, mainShaBefore, 'coordinator commit did not advance its branch');

      // Real beads database in the throwaway repo — `sp run --bead` reads it
      // through `bd show --json`. --stealth keeps .beads/ out of git status so
      // step 11's porcelain check stays meaningful.
      assertSuccess('fixture bd init', run(BD, ['init', '--prefix', 'sc', '--stealth'], { cwd: project, env }));
      const created = run(BD, ['create', 'suite-c live lineage probe', '-t', 'task', '-p', '3', '--json'], { cwd: project, env });
      assertSuccess('fixture bd create', created);
      const beadId = JSON.parse(created.stdout).id;
      assert.ok(beadId, 'could not resolve fixture bead id');

      // ── STEP 7: dispatch a specialist child from the coordinator ──────────
      // A window in the COORDINATOR's session, cwd'd into the coordinator's
      // worktree: the same context a coordinator agent's own shell would have.
      // XTMUX_AGENT_BRANCH must arrive by inheritance from the session Core
      // created — that is the published-base contract under test.
      const coordSessionId = tmux('display-message', '-p', '-t', coordSessionName, '#{session_id}').stdout.trim();
      assert.ok(coordSessionId, 'could not resolve the coordinator session id');
      const dispatchWin = tmux('new-window', '-d', '-t', coordSessionName, '-c', coordWorktree, '-P', '-F', '#{pane_id}', 'sh');
      assert.equal(dispatchWin.status, 0, `could not open a dispatch window: ${dispatchWin.stderr}`);
      const dispatchPane = dispatchWin.stdout.trim();
      const branchEnv = paneRun(dispatchPane, 'branch-env', 'printenv XTMUX_AGENT_BRANCH');
      assert.equal(branchEnv.rc, 0, 'XTMUX_AGENT_BRANCH did not reach the coordinator session');
      assert.equal(branchEnv.out.trim(), coordBranch, 'XTMUX_AGENT_BRANCH disagrees with @agent_branch');

      // Fire-and-forget: the agent turn outlives the assertions. Provisioning
      // happens before the first model call, so the branch appears in seconds
      // while the job itself may still be running when the lane finishes.
      tmux('send-keys', '-t', dispatchPane,
        `{ ${sandboxExports()}"${SP}" run ${LIVE_SPECIALIST} --bead ${beadId} --worktree ; } > ${path.join(box.root, 'dispatch.out')} 2>&1 &`,
        'Enter');

      let job = null;
      for (let i = 0; i < 240 && !job; i++) {
        sleepMs(1000);
        job = findJob(beadId);
      }
      const dispatchLog = () => (existsSync(path.join(box.root, 'dispatch.out'))
        ? readFileSync(path.join(box.root, 'dispatch.out'), 'utf8').slice(-1500)
        : '(no dispatch output)');
      assert.ok(job, `no specialist job provisioned a branch for ${beadId}:\n${dispatchLog()}`);
      r.ok(STEP_7, `job ${job.id} ${LIVE_SPECIALIST} → ${job.branch}`);

      // ── STEP 8: specialist branch derives from the coordinator branch ─────
      assert.notEqual(job.branch, coordBranch, 'specialist reused the coordinator branch');
      assert.equal(
        git(project, 'merge-base', '--is-ancestor', coordSha, job.branch).status, 0,
        `${job.branch} does not descend from the coordinator's commit ${coordSha.slice(0, 12)} `
        + `(branch ${coordBranch}); Specialists did not consume the published @agent_branch`,
      );
      r.ok(STEP_8, `${coordBranch}@${coordSha.slice(0, 12)} ⊂ ${job.branch}`);

      // ── STEP 9: descendant runtime-origin lineage ─────────────────────────
      // The branch exists as soon as the worktree is provisioned; the origin
      // binding is persisted a little later, when the supervisor writes the
      // job's status. Re-read until it lands rather than racing it.
      const originOf = (j) => j?.spawn_origin?.runtime_origin ?? j?.root_runtime_origin;
      let origin = originOf(job);
      for (let i = 0; i < 60 && !origin; i++) {
        sleepMs(1000);
        origin = originOf(findJob(beadId));
      }
      assert.ok(origin, `job ${job.id} carries no runtime origin:\n${dispatchLog()}`);
      assert.equal(origin.schema_version, 'xtrm.runtime-origin.v1', 'unexpected runtime-origin schema');
      const coordPanes = tmux('list-panes', '-s', '-t', coordSessionName, '-F', '#{pane_id}')
        .stdout.trim().split('\n');
      assert.equal(origin.tmux_session_id, coordSessionId, 'runtime origin does not name the coordinator session');
      assert.ok(coordPanes.includes(origin.tmux_pane_id), `runtime origin pane ${origin.tmux_pane_id} is not in the coordinator session`);
      r.ok(STEP_9, `origin ${origin.tmux_session_id}:${origin.tmux_pane_id} (${origin.capture_source})`);

      // ── STEP 10: merge the accepted specialist branch ─────────────────────
      // The commit is a fixture: a READ_ONLY probe specialist produces no
      // output of its own, and the subject here is the merge topology, not the
      // agent's work. Everything about the branches themselves is real.
      writeFileSync(path.join(job.worktree_path, 'SPECIALIST.md'), '# accepted specialist output\n');
      assert.equal(git(job.worktree_path, 'add', '-A').status, 0, 'specialist stage failed');
      assert.equal(git(job.worktree_path, 'commit', '-m', 'specialist: accepted output').status, 0, 'specialist commit failed');
      const specialistSha = git(job.worktree_path, 'rev-parse', 'HEAD').stdout.trim();
      const merged = git(coordWorktree, 'merge', '--no-ff', '-m', `merge ${job.branch}`, job.branch);
      assert.equal(merged.status, 0, `merge into the coordinator branch failed: ${merged.stderr}`);
      assert.equal(
        git(project, 'merge-base', '--is-ancestor', specialistSha, coordBranch).status, 0,
        'accepted specialist commit is not reachable from the coordinator branch',
      );
      r.ok(STEP_10, `${specialistSha.slice(0, 12)} → ${coordBranch}`);

      // Stop the agent before the sandbox is torn out from under it.
      run(SP, ['stop', job.id], { cwd: project, env });
    }
  }

  // ── STEP 11: confirm main remains unchanged ───────────────────────────────
  assert.equal(git(project, 'rev-parse', 'main').stdout.trim(), mainShaBefore, 'main moved during a coordinator launch');
  assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main', 'main worktree left the main branch');
  assert.equal(git(project, 'status', '--porcelain').stdout.trim(), '', 'coordinator launch dirtied the main worktree');
  r.ok('step 11: confirm main remains unchanged', mainShaBefore.slice(0, 12));

  const summary = r.summary();
  const deferred = summary.skip ? `, ${summary.skip} deferred to the live-agent lane (XTRM_SUITE_C_LIVE=1)` : '';
  console.log(`suite-c: ${summary.blocked ? 'BLOCKED' : 'PASS'} (${summary.pass} live${deferred})`);
} catch (error) {
  console.error(`\n  [FAIL] suite-c: ${error?.message ?? error}`);
  r.summary();
  exitCode = 1;
} finally {
  // `process.exit()` here would skip this block entirely and strand a tmux
  // server plus a sandbox tree on every run. Set the code, let cleanup run.
  tmux('kill-server');
  box.cleanup();
}

process.exit(exitCode);
