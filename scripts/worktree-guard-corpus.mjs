// worktree-guard-corpus.mjs — one table of removal commands and the answer every
// CORE-2814 guard must give (Claude PreToolUse hook, Pi extension, xt CLI parser).
//
// Four review rounds each found a regression in one direction or the other, so the
// corpus holds every case the three reviews named, plus the slashed-executable set,
// and runs unchanged against all three implementations. Each case states the
// expected answer, ALLOW or BLOCK, and why. The paths are built per fixture so a
// case never touches a real worktree.
//
// Usage (see cli/test/hooks/worktree-guard.test.ts and
// packages/pi-extensions/tests/worktree-guard.test.ts):
//   buildCorpus({ repo, live, idle, script, missing, outside, selfScript })

/**
 * @param {{ repo: string, live: string, idle: string, script: string, missing: string, outside: string, selfScript: string }} paths
 * @returns {{ id: string, command: string, expect: 'ALLOW' | 'BLOCK', why: string, cwd?: string }[]}
 */
export function buildCorpus(paths) {
  const { repo, live, idle, script, missing, outside, selfScript } = paths;
  const name = live.slice(live.lastIndexOf('/') + 1);
  const relative = live.slice(repo.length + 1);
  /** `bash -c "<program>"` repeated `levels` times, quoted so each level decodes
   * to the next program exactly. */
  const nest = (program, levels) => {
    let text = program;
    for (let level = 0; level < levels; level += 1) text = /['"\\]/.test(text) ? `bash -c ${JSON.stringify(text)}` : `bash -c '${text}'`;
    return text;
  };
  const cases = [];
  /** @param {string} id @param {string} command @param {'ALLOW'|'BLOCK'} expect @param {string} why
   * @param {string} [cwd] the directory the command runs in; the repo by default */
  const add = (id, command, expect, why, cwd) => cases.push(cwd ? { id, command, expect, why, cwd } : { id, command, expect, why });

  // --- a literal target inside a live worktree -----------------------------
  add('git-remove', `git worktree remove ${live}`, 'BLOCK', 'git worktree remove of a live tree');
  add('git-remove-force', `git worktree remove --force ${live}`, 'BLOCK', 'the 2026-11-28 command, one path');
  add('git-remove-dash-c', `git -C ${repo} worktree remove ${live}`, 'BLOCK', 'git -C keeps the target absolute');
  add('git-remove-trailing-slash', `git worktree remove ${live}/`, 'BLOCK', 'a trailing slash names the same tree');
  add('git-remove-relative', `git -C ${repo} worktree remove .xtrm/worktrees/${name}`, 'BLOCK', 'a relative target resolves against git -C');
  add('rm-rf', `rm -rf ${live}`, 'BLOCK', 'recursive rm of a live tree');
  add('rm-r', `rm -r ${live}`, 'BLOCK', 'lower-case -r');
  add('rm-R', `rm -R ${live}`, 'BLOCK', 'upper-case -R');
  add('rm-recursive', `rm --recursive ${live}`, 'BLOCK', 'the long flag');
  add('rm-dashdash', `rm -rf -- ${live}`, 'BLOCK', '-- terminates options, not the check');
  add('rm-single-quoted', `rm -rf '${live}'`, 'BLOCK', 'quoting does not hide the path');
  add('rm-double-quoted', `rm -rf "${live}"`, 'BLOCK', 'quoting does not hide the path');
  add('rm-slashed', `/bin/rm -rf ${live}`, 'BLOCK', 'a slashed executable is matched by basename');
  add('rm-command-wrapper', `command rm -rf ${live}`, 'BLOCK', 'command runs the same rm');
  add('rm-nice', `nice -n 5 rm -rf ${live}`, 'BLOCK', 'nice wraps the removal');
  add('rm-timeout', `timeout 5 rm -rf ${live}`, 'BLOCK', 'timeout wraps the removal');
  add('rm-nohup', `nohup rm -rf ${live}`, 'BLOCK', 'nohup wraps the removal');
  add('rm-sudo', `sudo rm -rf ${live}`, 'BLOCK', 'sudo wraps the removal');
  add('rm-sudo-slashed', `sudo -n /bin/rm -rf ${live}`, 'BLOCK', 'sudo option plus a slashed rm');
  add('rm-env-assignment', `env FOO=1 rm -rf ${live}`, 'BLOCK', 'env assignments precede the command');
  add('rm-env-unset', `env -u FOO rm -rf ${live}`, 'BLOCK', 'env options precede the command');
  add('rm-setsid', `setsid rm -rf ${live}`, 'BLOCK', 'setsid wraps the removal');
  add('rm-flock', `flock /tmp/xtrm-corpus.lock rm -rf ${live}`, 'BLOCK', 'flock wraps the removal');
  add('rm-parallel', `parallel rm -rf ::: ${live}`, 'BLOCK', 'parallel fans the removal out');

  // --- the directory a target is relative to ------------------------------
  add('env-chdir', `env -C ${repo} rm -rf .xtrm/worktrees/${name}`, 'BLOCK', 'env -C changes the directory (N2)');
  add('sudo-chdir', `sudo -D ${live} rm -rf .`, 'BLOCK', 'sudo -D changes the directory (N2)');
  add('cd-and-rm', `cd ${live} && rm -rf .`, 'BLOCK', 'cd carries the directory to the removal');
  add('cd-semicolon', `cd ${live}; rm -rf .`, 'BLOCK', '; keeps the directory too');
  add('rm-parent-trick', `rm -rf ${live}/../${name}`, 'BLOCK', 'resolve normalises .. back onto the tree');
  add('rm-into-tree', `rm -rf ${live}/sub/..`, 'BLOCK', '.. resolves back to the live tree');
  add('rm-inside-tree', `rm -rf ${live}/dist/*`, 'BLOCK', 'a bound inside a live tree is at risk');
  add('dot', `rm -rf .`, 'BLOCK', 'the cwd is the live tree when run there');
  add('dot-slash', `rm -rf ./`, 'BLOCK', 'the cwd with a trailing slash');
  add('glob-cwd', `rm -rf *`, 'BLOCK', 'a glob in a live tree bounds to the tree itself');

  // --- find ---------------------------------------------------------------
  add('find-delete', `find ${live} -delete`, 'BLOCK', 'find -delete removes the tree');
  add('find-name-delete', `find ${live} -name x -delete`, 'BLOCK', 'a filtered -delete still removes');
  add('find-exec', `find ${live} -exec rm -rf {} +`, 'BLOCK', 'find -exec rm');
  add('find-execdir', `find ${live} -execdir rm -f {} \\;`, 'BLOCK', 'find -execdir rm');
  add('find-dot-delete', `cd ${live} && find . -delete`, 'BLOCK', 'find from inside the tree');

  // --- nested programs ----------------------------------------------------
  add('bash-c', `bash -c 'rm -rf ${live}'`, 'BLOCK', 'bash -c payload');
  add('sh-lc', `sh -lc "rm -rf ${live}"`, 'BLOCK', 'sh -lc payload');
  add('zsh-c', `zsh -c 'rm -rf ${live}'`, 'BLOCK', 'zsh -c payload');
  add('eval', `eval 'rm -rf ${live}'`, 'BLOCK', 'eval payload');
  add('bash-c-nested', `bash -c "bash -c 'rm -rf ${live}'"`, 'BLOCK', 'nested shells');
  add('bash-script', `bash ${script}`, 'BLOCK', 'a readable script is parsed');
  add('source-script', `source ${script}`, 'BLOCK', 'source runs the script');
  add('dot-script', `. ${script}`, 'BLOCK', '. runs the script');
  add('script-executable', `${script}`, 'BLOCK', 'a readable script as the command word');
  add('heredoc', `cat <<EOF\nrm -rf ${live}\nEOF`, 'BLOCK', 'a here-doc body is still a command line');

  // --- audit round 3: quoting, nesting depth, wrapper directories ----------
  add('ansi-c-quote', `bash -c $'git worktree remove --force ${live}'`, 'BLOCK', "a $'...' payload is one quoted word (round 3)");
  add('ansi-c-quote-rm', `bash -c $'rm -rf ${live}'`, 'BLOCK', "a $'...' rm payload (round 3)");
  add('locale-quote', `bash -c $"git worktree remove --force ${live}"`, 'BLOCK', 'a $"..." payload is one quoted word');
  add('depth-four', nest(`rm -rf ${live}`, 4), 'BLOCK', 'nesting past the cap still blocks on a removal verb (round 3)');
  add('depth-five', nest(`git worktree remove --force ${live}`, 5), 'BLOCK', 'depth five is past the cap and still blocks');
  add('env-chdir-git', `env -C ${repo} git worktree remove --force ${relative}`, 'BLOCK', 'env -C applies to git (round 3)');
  add('env-chdir-eq-rm', `env --chdir=${repo} rm -rf ${relative}`, 'BLOCK', '--chdir=dir applies to rm');
  add('env-chdir-slashed', `env -C ${repo} /bin/rm -rf ${relative}`, 'BLOCK', 'env -C applies to a slashed rm');
  add('command-chdir', `command -C ${repo} git worktree remove ${relative}`, 'BLOCK', 'every wrapper may name the directory');

  // --- the incident shapes ------------------------------------------------
  add('incident-loop', `git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done`, 'BLOCK', 'the exact 2026-11-28 loop');
  add('for-loop', `for w in $(git worktree list --porcelain); do git worktree remove --force "$w"; done`, 'BLOCK', 'a for loop over worktrees');
  add('xargs-rm', `xargs rm -rf`, 'BLOCK', 'a removal with no static target while a tree is live');
  add('var-target', `git worktree remove "$WT"`, 'BLOCK', 'an unbounded target while a tree is live');
  add('unbounded-rm', `rm -rf "$UNKNOWN_TARGET"`, 'BLOCK', 'an unbounded rm while a tree is live');
  add('unbounded-find', `find "$X" -delete`, 'BLOCK', 'an unbounded find while a tree is live');
  add('rev-parse-target', `rm -rf $(git rev-parse --show-toplevel)`, 'BLOCK', 'a substitution as the whole target');

  // --- symlinks -----------------------------------------------------------
  add('rm-symlink', `rm -rf ${outside}/link`, 'BLOCK', 'a symlink to the live tree is the live tree');
  add('rm-symlink-slash', `rm -rf ${outside}/link/`, 'BLOCK', 'a symlink with a trailing slash');
  add('find-symlink', `find ${outside}/link -delete`, 'BLOCK', 'find through a symlink');

  // --- git aliases --------------------------------------------------------
  add('git-alias-c', `git -c alias.x='worktree remove --force' x ${live}`, 'BLOCK', 'an alias defined in the same command');
  add('git-alias-qualified', `git -c core.alias.y='worktree remove' y ${live}`, 'BLOCK', 'a qualified alias key');
  add('git-config-env', `git --config-env=alias.x=ALIAS x "$WT"`, 'BLOCK', 'an environment alias is unbounded');

  // --- over-blocking regressions (N1, N3, N5) -----------------------------
  add('dist-glob', `rm -rf ${repo}/dist/*`, 'ALLOW', 'a build directory beside nested worktrees (N1)');
  add('build-var', `rm -rf ${repo}/build/$CONFIG`, 'ALLOW', 'a partial component bounds to build/ (N5)');
  add('out-var-delete', `find ${repo}/out/$X -delete`, 'ALLOW', 'a partial component bounds to out/ (N5)');
  add('tmp-var', `rm -rf /tmp/xtrm-nothing-here/$VAR`, 'ALLOW', 'a bound outside every worktree');
  add('tmp-glob', `rm -rf /tmp/xtrm-nothing-here/*`, 'ALLOW', 'a glob outside every worktree');
  add('tmp-find', `find /tmp/xtrm-nothing-here -delete`, 'ALLOW', 'find outside every worktree');
  add('push-delete', `git push --delete origin topic`, 'ALLOW', '--delete on push is not a removal (N3)');
  add('branch-delete', `git branch --delete old`, 'ALLOW', 'branch -d is not a worktree removal (N3)');
  add('grep-text', `grep -rn "worktree remove" docs`, 'ALLOW', 'a quoted phrase is not a command (N3)');
  add('commit-message', `git commit -m "rm -rf docs cleanup"`, 'ALLOW', 'a commit message is not a removal (N3)');
  add('echo-text', `echo "rm -rf /tmp/x"`, 'ALLOW', 'echo does not remove');
  add('cat-script', `cat ${script}`, 'ALLOW', 'reading a script removes nothing');
  add('rm-file', `rm -f ${live}/notes.txt`, 'ALLOW', 'a file inside a live tree is not the tree');
  add('node-eval', `node -e "console.log(1)"`, 'ALLOW', 'an interpreter payload is a documented limit');
  add('python-eval', `python3 -c "print(1)"`, 'ALLOW', 'an interpreter payload is a documented limit');
  add('rsync-delete', `rsync -a --delete src/ dst/`, 'ALLOW', 'rsync --delete is a documented limit');
  add('make-clean', `make clean`, 'ALLOW', 'a project target is not a worktree removal');
  add('git-status', `git status`, 'ALLOW', 'not a removal');
  add('git-worktree-list', `git worktree list`, 'ALLOW', 'not a removal');
  add('git-worktree-add', `git worktree add ../xtrm-corpus-new -b corpus`, 'ALLOW', 'adding is not removing');
  add('git-stash-drop', `git stash drop`, 'ALLOW', 'not a worktree removal');
  add('editor', `vim ${live}/notes.txt`, 'ALLOW', 'editing is not removing');
  add('unreadable-executable', `${missing}`, 'ALLOW', 'an unknown executable is allowed (N4)');
  add('unreadable-script', `bash ${missing}`, 'ALLOW', 'an unreadable script is allowed (N4)');
  add('home-scratch', `rm -rf $HOME/xtrm-corpus-scratch`, 'ALLOW', 'HOME expands; it is not a worktree (N4)');
  add('prune', `git worktree prune`, 'ALLOW', 'NON_GOAL: prune only clears metadata');
  add('idle-worktree', `git worktree remove ${idle}`, 'ALLOW', 'an idle worktree is removable');
  add('idle-rm', `rm -rf ${idle}`, 'ALLOW', 'an idle worktree is removable');
  add('idle-inside', `rm -rf ${idle}/dist/*`, 'ALLOW', 'a bound inside an idle tree is safe');

  // --- slashed and computed command words ---------------------------------
  add('slashed-git', `/usr/bin/git worktree remove ${live}`, 'BLOCK', 'a slashed git is matched by basename');
  add('relative-git', `./git worktree remove ${live}`, 'BLOCK', 'a relative git resolves by basename');
  add('slashed-find', `/usr/bin/find ${live} -delete`, 'BLOCK', 'a slashed find is matched by basename');
  add('sudo-slashed-git', `sudo /usr/bin/git worktree remove ${live}`, 'BLOCK', 'a slashed git behind sudo');
  add('env-slashed-rm', `env /bin/rm -rf ${live}`, 'BLOCK', 'a slashed rm behind env');
  add('env-slashed-find', `env /usr/bin/find ${live} -delete`, 'BLOCK', 'a slashed find behind env');
  add('reap-slashed', `/bin/rm -rf ${repo}/.xtrm/worktrees/${name}`, 'BLOCK', 'the reap shape with a slashed rm');
  add('worktrees-glob', `rm -rf ${repo}/.xtrm/worktrees/*`, 'BLOCK', 'the worktrees directory as a bound');
  add('worktrees-dir', `rm -rf ${repo}/.xtrm/worktrees`, 'BLOCK', 'the worktrees directory itself');
  add('repo-root', `rm -rf ${repo}`, 'BLOCK', 'the repository root contains the live tree');


  // --- audit round 2: shell shapes that used to slip through ---------------
  add('backtick', `echo \`git worktree remove --force ${live}\``, 'BLOCK', 'a backtick substitution runs the removal');
  add('dollar-which', `$(which rm) -rf ${live}`, 'BLOCK', 'a computed command word with a removal flag');
  add('bash-stdin', `bash < ${script}`, 'BLOCK', 'a program read from a file through stdin');
  add('relative-cd-chain', `cd ${repo} && cd .xtrm && cd worktrees && rm -rf ${name}`, 'BLOCK', 'three relative cd steps');
  add('subshell-cd', `(cd ${repo}/.xtrm/worktrees && rm -rf ${name})`, 'BLOCK', 'a cd inside a subshell');
  add('partial-glob', `rm -rf ${repo}/.xtrm/worktrees/li*`, 'BLOCK', 'a glob that matches the live tree (R1)');
  add('brace', `rm -rf ${repo}/.xtrm/worktrees/{${name},idle}`, 'BLOCK', 'a brace list bounded by the worktrees directory');
  add('xargs-i', `printf '%s\n' ${live} | xargs -I{} rm -rf {}`, 'BLOCK', 'xargs -I runs the removal');
  add('self-script', `bash ${selfScript}`, 'ALLOW', 'a self-sourcing script terminates and removes nothing');
  add('alias-persistent', `git rmlive ${live}`, 'BLOCK', 'a persisted alias is authoritative (R8)');
  add('alias-persistent-idle', `git rmlive ${idle}`, 'ALLOW', 'the alias resolves to an idle tree (R8)');
  add('bash-c-safe', `bash -c 'npm test'`, 'ALLOW', 'bash -c running tests (round 2 allows)');
  add('sh-c-safe', `sh -c 'echo hello'`, 'ALLOW', 'sh -c printing (round 2 allows)');
  add('eval-safe', `eval 'true'`, 'ALLOW', 'eval of a no-op (round 2 allows)');
  add('gh-body', `gh pr create --title t --body "git worktree remove ${live}"`, 'ALLOW', 'a quoted argument is not a command (N3)');
  add('home-executable', `~/bin/reap`, 'ALLOW', 'an executable the guard cannot read is allowed (N4)');
  add('quoted-repo-executable', `"$REPO/reap.sh"`, 'ALLOW', 'an unresolved executable is allowed (N4)');
  add('node-modules', `rm -rf ${repo}/node_modules/.cache`, 'ALLOW', 'a dependency cache beside nested worktrees');
  add('sibling-prefix', `rm -rf ${live}-copy`, 'ALLOW', 'a sibling name that only shares a prefix');
  add('sibling-prefix-short', `rm -rf ${repo}/.xtrm/worktrees/liv`, 'ALLOW', 'a prefix of the name is not the tree');

  // --- audit round 3 R1: judgement follows holders, not the caller repo ----
  add('cross-repo-worktrees-glob', `rm -rf ${repo}/.xtrm/worktrees/*`, 'BLOCK', 'another repo worktrees from outside it (R1)', outside);
  add('cross-repo-incident-loop', `git worktree list | awk '/xtrm\\/worktrees\\//{print $1}' | while read w; do git worktree remove --force "$w"; done`, 'BLOCK', 'the incident loop from a directory outside every repo (R1)', outside);
  add('cross-repo-git-c', `git -C ${repo} worktree list --porcelain | grep '^worktree ' | cut -d' ' -f2 | xargs -r git -C ${repo} worktree remove --force`, 'BLOCK', 'git -C into another repo from outside it (R1)', outside);
  add('glob-dot-log', `rm -rf ./*.log`, 'ALLOW', 'a glob that matches only a log file at the repo root (R1)', repo);
  add('glob-dot-worktrees', `rm -rf .xtrm/worktrees/*`, 'BLOCK', 'the same glob where it matches the live tree (R1)', repo);

  // --- audit round 3 R2-R8 -------------------------------------------------
  add('rm-recursive-abbrev', `rm -rf --recur ${live}`, 'BLOCK', 'GNU accepts an unambiguous --recursive (R2)');
  add('rm-recursive-abbrev-var', `rm --recursiv ${live}`, 'BLOCK', 'the shortest unambiguous abbreviation (R2)');
  add('find-exec-sh-c', `find ${repo} -exec sh -c 'rm -rf "$1"' _ {} \;`, 'BLOCK', 'the -exec payload is a shell program (R3)');
  add('find-exec-bash-c', `find ${repo} -name x -exec bash -c 'rm -rf {}' \;`, 'BLOCK', '{} is find start path inside the payload (R3)');
  add('find-exec-echo', `find ${repo} -exec echo {} \;`, 'ALLOW', 'a print payload removes nothing (R3)');
  add('env-split-string', `env -S "git worktree remove --force ${live}"`, 'BLOCK', 'env -S runs a command (R5)');
  add('env-chdir-joined', `env -C${repo} rm -rf .xtrm/worktrees/${name}`, 'BLOCK', 'the joined -C<dir> form (R6)');
  add('sudo-chdir-joined', `sudo -D${repo} rm -rf .xtrm/worktrees/${name}`, 'BLOCK', 'the joined sudo -D<dir> form (R6)');
  add('home-assignment', `HOME=${repo} rm -rf ~/.xtrm/worktrees/${name}`, 'BLOCK', 'HOME= before the command expands ~ (R7)');
  add('home-export', `export HOME=${repo}; rm -rf ~/.xtrm/worktrees/${name}`, 'BLOCK', 'export HOME changes the following command (R7)');
  add('home-assignment-scratch', `HOME=/tmp/xtrm-corpus-home rm -rf ~/nothing-here`, 'ALLOW', 'the assignment bounds ~ outside every worktree (R7)');

  return cases;
}

/** The number the report quotes: every case runs against all three copies. */
export const CORPUS_CASE_COUNT = 146;
