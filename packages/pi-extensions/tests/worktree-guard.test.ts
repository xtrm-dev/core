import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { worktreeGuardReason } from '../extensions/worktree-guard/index.ts';
import { removalOperations, worktreeInUse } from '../src/core/worktree-liveness.ts';

// CORE-2814: the Pi guard blocks the exact loop that force-removed 16 worktrees
// on 2026-11-28, and the rm/find forms around it, while a live process sits in
// the target. Fixtures are throwaway repos under a temp dir; no live worktree
// and no default tmux server is touched.

const INCIDENT_LOOP = `git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done`;

const cleanup: Array<() => void> = [];

afterEach(() => {
	while (cleanup.length > 0) cleanup.pop()?.();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function fixture(): { repo: string; worktree: string } {
	const root = tempDir('xtrm-pi-guard-');
	const repo = join(root, 'repo');
	const worktree = join(root, 'wt');
	spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
	git(repo, ['config', 'user.email', 'guard@example.invalid']);
	git(repo, ['config', 'user.name', 'guard test']);
	spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { encoding: 'utf8' });
	git(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
	return { repo, worktree };
}

function spawnSleeping(cwd: string): ChildProcess {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
	cleanup.push(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	});
	return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error('condition not reached before timeout');
}

function readCwd(pid: number): string | null {
	const result = spawnSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : null;
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once('exit', () => resolve());
		child.kill('SIGKILL');
	});
}

describe('Pi worktree guard', () => {
	test('blocks the incident loop while another process lives in a worktree, then allows it', async () => {
		const { repo, worktree } = fixture();
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === worktree);

		const reason = worktreeGuardReason(INCIDENT_LOOP, repo, { tmuxSockets: [] });
		expect(reason).toBeTruthy();
		expect(reason).toContain('CORE-2814');
		expect(reason).toContain(`pid ${child.pid}`);
		expect(reason).toContain(worktree);

		await stop(child);
		await waitFor(() => worktreeGuardReason(INCIDENT_LOOP, repo, { tmuxSockets: [] }) === null);
	}, 20000);

	test('blocks git worktree remove with and without --force', async () => {
		const { repo, worktree } = fixture();
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === worktree);

		for (const command of [`git worktree remove ${worktree}`, `git worktree remove --force ${worktree}`]) {
			const reason = worktreeGuardReason(command, repo, { tmuxSockets: [] });
			expect(reason, command).toBeTruthy();
			expect(reason).toContain(`pid ${child.pid}`);
		}
	}, 20000);

	test('blocks rm -rf and find -delete against a live worktree', async () => {
		const { repo, worktree } = fixture();
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === worktree);

		const isolated = { tmuxSockets: [] };
		expect(worktreeGuardReason(`rm -rf ${worktree}`, repo, isolated)).toContain(`pid ${child.pid}`);
		expect(worktreeGuardReason(`find ${worktree} -name node_modules -delete`, repo, isolated)).toContain(`pid ${child.pid}`);
	}, 20000);

	test('allows git worktree prune, additive worktree commands and non-removal commands', () => {
		const { repo } = fixture();
		for (const command of [
			'git worktree prune',
			'git worktree list',
			'git worktree add ../wt2 -b other',
			'rm -f ../file.txt',
			'git status',
		]) {
			expect(worktreeGuardReason(command, repo, { tmuxSockets: [] }), command).toBeNull();
		}
	});

	test('blocks a removal while a private tmux pane sits in the worktree', async () => {
		const { repo, worktree } = fixture();
		const dir = tempDir('xtrm-pi-guard-tmux-');
		const socket = join(dir, 'private.sock');
		cleanup.push(() => {
			spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8' });
			rmSync(socket, { force: true });
		});
		const started = spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'guard', '-c', worktree, 'sleep', '300'], { encoding: 'utf8' });
		expect(started.status, String(started.stderr)).toBe(0);

		// pane_current_path is set asynchronously by the server, so wait for the read.
		let reason: string | null = null;
		await waitFor(() => (reason = worktreeGuardReason(`git worktree remove ${worktree}`, repo, { tmuxSockets: [socket] })) !== null);
		expect(reason).toBeTruthy();
		expect(reason).toContain('tmux pane');
		expect(reason).toContain(worktree);
	}, 20000);

	// The review's HIGH finding: these nine shapes got past the first version.
	test('blocks the bypass shapes: symlink, wrappers, nested shells, scripts, redirections', async () => {
		const { repo, worktree } = fixture();
		const link = join(repo, 'live-link');
		symlinkSync(worktree, link);
		const script = join(repo, 'kill.sh');
		writeFileSync(script, `#!/bin/bash\nrm -rf ${worktree}\n`);
		const safeScript = join(repo, 'safe.sh');
		writeFileSync(safeScript, `#!/bin/bash\nls ${worktree}\n`);

		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));

		const blocked = [
			`rm -rf ${link}/`,
			`find ${link} -delete`,
			`env git worktree remove --force ${worktree}`,
			`sudo git worktree remove --force ${worktree}`,
			`xargs git worktree remove --force ${worktree}`,
			`bash -c 'rm -rf ${worktree}'`,
			`sh -c "git worktree remove --force ${worktree}"`,
			`bash ${script}`,
			`git worktree remove 2>/dev/null --force ${worktree}`,
		];
		for (const command of blocked) {
			const reason = worktreeGuardReason(command, repo, { tmuxSockets: [] });
			expect(reason, command).toBeTruthy();
			expect(reason, command).toContain(`pid ${child.pid}`);
		}
		expect(worktreeGuardReason(`bash ${safeScript}`, repo, { tmuxSockets: [] })).toBeNull();
		await stop(child);
	});

	test('expands a git alias and keeps wrapper flags per wrapper', async () => {
		const { repo, worktree } = fixture();
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));

		const blocked = [
			`git -c alias.x='worktree remove --force' x ${worktree}`,
			`git --config-env=alias.x=ALIAS x ${worktree}`,
			`git -c core.alias.y='worktree remove' y ${worktree}`,
			`command -p git worktree remove --force ${worktree}`,
			`sudo -p prompt git worktree remove --force ${worktree}`,
		];
		for (const command of blocked) {
			const reason = worktreeGuardReason(command, repo, { tmuxSockets: [] });
			expect(reason, command).toBeTruthy();
			expect(reason, command).toContain(`pid ${child.pid}`);
		}
		expect(worktreeGuardReason(`git -c alias.x='status' x`, repo, { tmuxSockets: [] })).toBeNull();
		await stop(child);
	});

	test('exempts the caller tree through a symlink', () => {
		const { repo, worktree } = fixture();
		const link = join(repo, 'own-link');
		symlinkSync(worktree, link);
		expect(worktreeGuardReason(`rm -rf ${link}/`, worktree, { tmuxSockets: [] })).toBeNull();
		expect(worktreeGuardReason(`git worktree remove --force ${link}`, worktree, { tmuxSockets: [] })).toBeNull();
	});

	test('allows removing the worktree the caller stands in', () => {
		const { worktree } = fixture();
		expect(worktreeGuardReason(`git worktree remove --force ${worktree}`, worktree, { tmuxSockets: [] })).toBeNull();
	});

	test('is not live after the holder exits', async () => {
		const { worktree } = fixture();
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === worktree);
		expect(worktreeInUse(worktree, { panes: [] }).live).toBe(true);
		await stop(child);
		await waitFor(() => !worktreeInUse(worktree, { panes: [] }).live);
	});

	test('takes the fast path for a command with no removal shape', () => {
		const { repo } = fixture();
		const started = process.hrtime.bigint();
		for (let i = 0; i < 20; i += 1) worktreeGuardReason('git status', repo, { tmuxSockets: [] });
		const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 20;
		expect(perCallMs).toBeLessThan(100);
	});

	test('parses the removal forms in the contract', () => {
		expect(removalOperations(INCIDENT_LOOP).map((op) => op.kind)).toEqual(['git-worktree-remove']);
		expect(removalOperations('git worktree prune')).toEqual([]);
		expect(removalOperations('rm -rf /tmp/wt').map((op) => op.targets)).toEqual([['/tmp/wt']]);
		expect(removalOperations('find /tmp/wt -delete').map((op) => op.kind)).toEqual(['find-delete']);
	});
});

// Audit F1/F2/F3/F4: the same ruling the Claude hook follows. A live worktree
// elsewhere must not block a command that cannot reach it; a removal that hides
// its target behind a shell construct still blocks.
describe('Pi worktree guard audit shapes', () => {
	test('allows unparseable and unbounded-looking commands that cannot remove a live worktree', async () => {
		const { repo, worktree } = fixture();
		const root = repo.slice(0, repo.lastIndexOf('/'));
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));

		for (const command of [
			`bash -c 'npm test'`,
			`sh -c 'echo hello'`,
			`node -e "console.log(1)"`,
			`python3 -c "print(1)"`,
			`rm -rf /tmp/xtrm-nothing-here/$VAR`,
			`rm -rf /tmp/xtrm-nothing-here/*`,
			`find /tmp/xtrm-nothing-here -name x -delete`,
			`git worktree prune`,
		]) {
			expect(worktreeGuardReason(command, repo, { tmuxSockets: [] }), command).toBeNull();
		}

		const glob = worktreeGuardReason(`rm -rf ${root}/*`, repo, { tmuxSockets: [] });
		expect(glob).toBeTruthy();
		expect(glob).toContain(`pid ${child.pid}`);

		for (const command of [`rm -rf "$UNKNOWN_TARGET"`, 'rm -rf ~', `find "$X" -delete`]) {
			const reason = worktreeGuardReason(command, repo, { tmuxSockets: [] });
			expect(reason, command).toBeTruthy();
			expect(reason, command).toContain('use a literal path');
		}
		await stop(child);
	});

	test('tracks cd through && and ; and resolves a relative target against it', async () => {
		const { repo, worktree } = fixture();
		const root = repo.slice(0, repo.lastIndexOf('/'));
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));

		for (const command of [
			`cd ${root} && rm -rf wt`,
			`cd ${root}; rm -rf wt`,
			`cd ${root} || rm -rf wt`,
			`cd ${worktree} && rm -rf .`,
			`pushd ${root} && rm -rf wt`,
		]) {
			const reason = worktreeGuardReason(command, repo, { tmuxSockets: [] });
			expect(reason, command).toBeTruthy();
			expect(reason, command).toContain(`pid ${child.pid}`);
		}

		expect(worktreeGuardReason(`cd ${root} && rm -rf repo/nothing`, repo, { tmuxSockets: [] })).toBeNull();
		const unresolvedCd = worktreeGuardReason('cd $SOMEWHERE && rm -rf wt', repo, { tmuxSockets: [] });
		expect(unresolvedCd).toBeTruthy();
		expect(unresolvedCd).toContain('use a literal path');
		await stop(child);
	});

	test('blocks find -exec, local scripts, source, bash < file, backticks, setsid, flock, parallel and $(which rm)', async () => {
		const { repo, worktree } = fixture();
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));
		const kill = join(repo, 'kill.sh');
		writeFileSync(kill, `#!/bin/bash\nrm -rf ${worktree}\n`);
		const feed = join(repo, 'feed.sh');
		writeFileSync(feed, `rm -rf ${worktree}\n`);

		const blocked = [
			`find ${worktree} -exec rm -rf {} +`,
			`find ${worktree} -execdir rm -rf {} \\;`,
			`./kill.sh`,
			`source ./kill.sh`,
			`. ./kill.sh`,
			`bash < ${feed}`,
			`sh < ${feed}`,
			`echo \`rm -rf ${worktree}\``,
			`setsid git worktree remove --force ${worktree}`,
			`flock /tmp/xtrm.lock git worktree remove --force ${worktree}`,
			`parallel rm -rf {} ::: ${worktree}`,
			`$(which rm) -rf ${worktree}`,
		];
		for (const command of blocked) {
			const reason = worktreeGuardReason(command, repo, { tmuxSockets: [] });
			expect(reason, command).toBeTruthy();
			expect(reason, command).toContain(`pid ${child.pid}`);
		}
		await stop(child);
	});

	test('recognises a verb by its basename when the executable is a path', async () => {
		const { repo, worktree } = fixture();
		const child = spawnSleeping(worktree);
		await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));

		const blocked = [
			`/usr/bin/git worktree remove --force ${worktree}`,
			`/bin/rm -rf ${worktree}`,
			`/usr/bin/find ${worktree} -delete`,
			`./git worktree remove --force ${worktree}`,
			`sudo /usr/bin/git worktree remove --force ${worktree}`,
			`env /bin/rm -rf ${worktree}`,
			`env /usr/bin/find ${worktree} -delete`,
		];
		for (const command of blocked) {
			const reason = worktreeGuardReason(command, repo, { tmuxSockets: [] });
			expect(reason, command).toBeTruthy();
			expect(reason, command).toContain(`pid ${child.pid}`);
		}
		await stop(child);
	});

	test('blocks a second holder in the caller own worktree', async () => {
		const { repo } = fixture();
		const ours = spawnSleeping(process.cwd());
		const other = spawnSleeping(repo);
		await waitFor(() => readCwd(other.pid as number) === realpathSync(repo));

		const reason = worktreeGuardReason(`rm -rf ${repo}`, process.cwd(), { tmuxSockets: [] });
		expect(reason).toBeTruthy();
		expect(reason).toContain(`pid ${other.pid}`);
		await stop(other);
		await stop(ours);
	});
});
