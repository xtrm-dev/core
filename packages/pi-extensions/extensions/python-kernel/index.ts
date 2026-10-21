/**
 * Persistent Python Kernel Tool (managed, xtrm-3ljgz.1)
 *
 * Adds a `python` tool backed by one persistent python3 process per session.
 * State (variables, imports, functions) survives across calls — the
 * differentiator over `bash`, which is stateless per call.
 *
 * Transport: a small driver script runs as a JSON-lines RPC loop. Each tool
 * call sends a JSON-encoded cell; the driver exec()s it in a shared namespace
 * and replies with structured { stdout, stderr, error, duration_ms }. No pty,
 * no jupyter, no terminal noise.
 *
 * Semantics (mirror prime-agent's kernel doctrine):
 * - Python state persists across cells until reset: true.
 * - os.chdir() inside a cell persists; reset returns to the working directory.
 * - The process runs with user permissions — not a sandbox.
 *
 * Prerequisite: python3 must be on PATH (or configured via `pythonBin`). A
 * missing interpreter is reported as a structured tool error on every call —
 * the kernel never crashes the host.
 *
 * Migration: this extension replaced the user-local
 * ~/.pi/agent/extensions/python-kernel.ts. Copy any customisations forward,
 * then remove the loose file manually; xt never deletes user-owned files.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	clearPythonBackedSkillsCache as clearCanonicalSelectionCache,
	selectPythonBackedSkills as selectCanonicalPythonBackedSkills,
} from "./select-python-backed-skills.ts";

const DRIVER = `
import json, sys, time, traceback, contextlib, io, os, importlib

# Long-lived kernel: never write .pyc files. Python's bytecode cache is mtime-
# resolution stale — a skill edit inside the same second then re-imports stale
# bytecode after a del sys.modules (the reload_skills trap). No cache, no trap.
sys.dont_write_bytecode = True

_ns = {}
_sk_errors = []

# audit seam (xtrm-h7uwi.3): skill convention — kernel-side file mutations are
# appended to _AUDIT as {"op": "write", "path": ...} entries. The driver
# copies the list into every run_cell reply so the host can log/policy-gate
# them. Convention-first: no enforcement yet, and skills that do not set it
# simply produce an empty audit list.
_ns["_AUDIT"] = []

# skillbridge (xtrm-h7uwi.1): mount python-backed skills as importable kernel
# modules. PI_SKILL_PATHS is os.pathsep-joined roots; each is prepended to
# sys.path (zero-install mount — skills have no external deps; a pythonBin
# override is the escape hatch). PI_SKILL_IMPORTS is a comma list of module
# names; each is imported and bound into _ns under its name. Per-module
# failures are recorded, never fatal — a broken skill must not kill the kernel.
for _p in (os.environ.get("PI_SKILL_PATHS", "") or "").split(os.pathsep):
    _p = _p.strip()
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)
for _name in (os.environ.get("PI_SKILL_IMPORTS", "") or "").split(","):
    _name = _name.strip()
    if not _name:
        continue
    try:
        _mod = importlib.import_module(_name)
        # Audit seam: bind the shared _AUDIT list into the skill module so its
        # functions can append mutation entries with a bare _AUDIT reference.
        setattr(_mod, "_AUDIT", _ns["_AUDIT"])
        _ns[_name] = _mod
    except Exception as _e:
        _sk_errors.append({"module": _name, "ename": type(_e).__name__, "evalue": str(_e)})
# Loop vars above are module-level (never in _ns); leave them, they are harmless.

# kernel binding (xtrm-6z6.4): mount the installed service_knowledge package
# into the namespace when a service registry is present in the cwd (the TS
# side resolves PI_SK_PACKAGE_PATH via the kernel's own interpreter, so it is
# venv-aware). Failures are recorded, never fatal — a missing package must not
# kill the kernel.
_pkg_path = os.environ.get("PI_SK_PACKAGE_PATH", "") or ""
if _pkg_path:
    if _pkg_path not in sys.path:
        sys.path.insert(0, _pkg_path)
    try:
        _ns["service_knowledge"] = importlib.import_module("service_knowledge")
    except Exception as _e:
        _sk_errors.append({"module": "service_knowledge", "ename": type(_e).__name__, "evalue": str(_e)})
del _pkg_path

def _apply_prelude():
    """Re-inject kernel invariants into _ns (QoL prelude + audit seam). Called
    at boot and after every reset — reset clears user state, but the prelude
    and _AUDIT are durable kernel invariants: the tool description documents
    the prelude unconditionally, and the audit list must keep existing for
    skills that append to it (xtrm-vs7f8 readme-check finding)."""
    import re as _re, subprocess as _subprocess
    from pathlib import Path as _Path
    _ns.update({"json": json, "re": _re, "os": os, "sys": sys, "subprocess": _subprocess, "Path": _Path})
    _ns.setdefault("_AUDIT", [])
    # kernel binding (xtrm-6z6.4): after reset, re-mount service_knowledge
    # (the package is already on sys.path from boot; just re-import the binding).
    if "service_knowledge" in _ns or "service_knowledge" in sys.modules:
        try:
            _ns["service_knowledge"] = importlib.import_module("service_knowledge")
        except Exception:
            pass
    # Re-bind the in-kernel index-rebuild helper (defined below at module scope;
    # resolved at call time).
    try:
        _ns["sk_rebuild"] = sk_rebuild
    except NameError:
        pass
    # Re-bind the file-scoped memory-retrieval digest (module scope, defined
    # below; resolved at call time). Durable like the rest of the prelude.
    try:
        _ns["preflight"] = preflight
    except NameError:
        pass
    # Namespace mirror (kns): durable like the rest of the prelude.
    try:
        _ns["kns"] = kns
    except NameError:
        pass


_apply_prelude()

def sk_rebuild():
    """Rebuild the service-knowledge FTS5 evidence index in-kernel (xtrm-6z6.4).
    Writes the sqlite cache under .xtrm/cache/ — the mutation rides the audit
    seam so the host sees it in the tool details. No-op (returns None) when the
    package is not mounted."""
    sk = _ns.get("service_knowledge")
    if sk is None:
        return None
    try:
        # The index submodule is lazily imported; importlib.import_module makes
        # it available as service_knowledge.index regardless of prior imports.
        import importlib as _il
        _idx = _il.import_module("service_knowledge.index")
        from pathlib import Path as _P
        stats = _idx.build(_P(os.getcwd()))
        _ns["_AUDIT"].append({"op": "write", "path": os.path.join(os.getcwd(), ".xtrm", "cache", "service-knowledge.sqlite"), "kind": "index-rebuild"})
        return {"items": getattr(stats, "items", None), "duration_ms": getattr(stats, "duration_ms", None)}
    except Exception as _e:
        return {"error": {"ename": type(_e).__name__, "evalue": str(_e)}}


# Bind the in-kernel helper into _ns (cells eval in _ns, not module scope).
_ns["sk_rebuild"] = sk_rebuild

_GENERIC_NAMES = ("index", "mod", "main", "__init__", "lib", "app", "core", "types")


def preflight(repo, path, n=4):
    """File-scoped memory-retrieval digest (memory doctrine: progressive
    retrieval, never bulk). For ONE file: full commit messages with bodies
    (git log --follow), pending diff --stat, and bd memories hits for the
    filename stem — or, when that stem is a generic module name (index, mod,
    main, ...), the nearest meaningful parent directory, since "index" keys
    nothing. Read-only (no _AUDIT entries); prints a bounded digest and
    stashes the records in _preflight_cache[(repo, path)] and returns them. 0 commits
    usually means a wrong path — treat it as a failed preflight."""
    import subprocess as _sp

    def _git(*_a):
        return _sp.run(["git", "-C", repo, *_a], capture_output=True, text=True).stdout

    _fs, _rs = chr(31), chr(30)
    _raw = _git("log", "--follow", "--no-merges", "--date=short",
                "--format=%x1e%x1f%h%x1f%ad%x1f%s%x1f%b", "--", path)
    _cs = []
    for _x in (_x for _x in _raw.split(_rs) if _x.strip()):
        _p = [_f.strip("\\n") for _f in _x.strip(_fs).split(_fs)]
        if len(_p) >= 4:
            _cs.append((_p[0], _p[1], _p[2], _fs.join(_p[3:])))
    _parts = [_q for _q in path.split("/") if _q not in (".", "")]
    _topic = _parts[-1].split(".")[0] if _parts else ""
    while _topic.lower() in _GENERIC_NAMES and len(_parts) > 1:
        _parts.pop()
        _topic = _parts[-1].split(".")[0]
    if not _cs:
        print("== %s: 0 commits — wrong path? (memory topic: %s) ==" % (path, _topic))
        return []
    _diff = _git("diff", "HEAD", "--stat", "--", path).strip()
    try:
        _mem = _sp.run(["bd", "memories", _topic],
                       capture_output=True, text=True, cwd=repo).stdout or ""
    except Exception:
        _mem = ""
    _keys = [_l.strip() for _l in _mem.splitlines()
             if _l.strip() and not _l.startswith("Memories")][::2][:6]
    print("== %s: %d commits (memory topic: %s) ==" % (path, len(_cs), _topic))
    for _h, _d, _s, _b in _cs[:n]:
        _body = " / ".join(_l.strip() for _l in _b.splitlines() if _l.strip())[:110]
        print("  %s %s %s%s" % (_d, _h, _s[:72], "\\n         " + _body if _body else ""))
    if _diff:
        print("== pending diff ==\\n" + _diff)
    if _keys:
        print("== bd memory keys (%s): %s ==" % (_topic, _keys))
    _ns.setdefault("_preflight_cache", {})[(repo, path)] = _cs
    return _cs


# Bind the preflight digest into _ns (memory-doctrine workbench helper).
_ns["preflight"] = preflight

def kns():
    """Namespace mirror: user bindings -> shape hint. Run when resuming,
    after long threads, or before re-deriving anything."""
    _skip = ("json", "re", "os", "sys", "subprocess", "Path", "preflight",
             "sk_rebuild", "kns", "service_knowledge")
    _rows = []
    for _k in sorted(_ns):
        if _k.startswith("_") or _k in _skip:
            continue
        _v = _ns[_k]
        try:
            _h = type(_v).__name__ + " len=" + str(len(_v))
        except TypeError:
            _h = type(_v).__name__
        _rows.append("  %s: %s" % (_k, _h))
    print("\\n".join(_rows) if _rows else "  (no user bindings)")
    return None


# Bind the mirror into _ns (cells eval in _ns, not module scope).
_ns["kns"] = kns

def _reload_skills(new_paths=None, new_imports=None):
    """Re-import every mounted skill module (dev-loop honesty: del sys.modules,
    re-import, refresh the binding; record per-module failures, never raise).
    With new_paths/new_imports (per-cwd re-resolve), sys.path is updated
    first — deselected roots leave sys.path — and deselected bindings leave
    _ns. Without them, the boot-time PI_SKILL_* env is re-imported; user-
    imported modules in _ns are left alone either way."""
    _old_imports = [_n.strip() for _n in (os.environ.get("PI_SKILL_IMPORTS", "") or "").split(",") if _n.strip()]
    if new_paths is not None:
        _wanted = [_p.strip() for _p in (new_paths or []) if (_p or "").strip()]
        for _p in [(_o or "").strip() for _o in (os.environ.get("PI_SKILL_PATHS", "") or "").split(os.pathsep) if (_o or "").strip()]:
            if _p and _p not in _wanted and _p in sys.path:
                try:
                    sys.path.remove(_p)
                except ValueError:
                    pass
        for _p in _wanted:
            if _p and _p not in sys.path:
                sys.path.insert(0, _p)
        os.environ["PI_SKILL_PATHS"] = os.pathsep.join(_wanted)
    _names = list(new_imports) if new_imports is not None else _old_imports
    if new_imports is not None:
        os.environ["PI_SKILL_IMPORTS"] = ",".join(_names)
        for _gone in _old_imports:
            if _gone not in _names:
                _ns.pop(_gone, None)
                try:
                    del sys.modules[_gone]
                except KeyError:
                    pass
    for _name in _names:
        _name = (_name or "").strip()
        if not _name:
            continue
        try:
            del sys.modules[_name]
        except KeyError:
            pass
        try:
            _mod = importlib.import_module(_name)
            setattr(_mod, "_AUDIT", _ns["_AUDIT"])
            _ns[_name] = _mod
        except Exception as _e:
            _sk_errors.append({"module": _name, "ename": type(_e).__name__, "evalue": str(_e)})


def _shape_hint(result):
    """Object-shape hint when detectable: type + len for sized objects."""
    if result is None:
        return None
    try:
        return type(result).__name__ + " len=" + str(len(result))
    except TypeError:
        return type(result).__name__


def _truncate(text, max_chars, tmp_dir, seq):
    """Cap cell output to max_chars: head + marker + tail. When truncated, the
    full text is written to a temp file (path returned) so nothing is lost."""
    if len(text) <= max_chars:
        return text, None
    head_n, tail_n = 8192, 4096
    marker = "\\n...[truncated " + str(len(text)) + " chars]...\\n"
    truncated = text[:head_n] + marker + text[-tail_n:]
    full_path = None
    if tmp_dir:
        full_path = os.path.join(tmp_dir, "cell-" + str(seq) + ".out")
        try:
            with open(full_path, "w", encoding="utf-8", errors="replace") as _f:
                _f.write(text)
        except OSError:
            full_path = None
    return truncated, full_path


def run_cell(code, reset=False, cwd=None, seq=None, max_output=20000, tmp_dir=None):
    if reset:
        _ns.clear()
        _apply_prelude()
        if cwd:
            os.chdir(cwd)
        return {"stdout": "", "stderr": "", "error": None, "duration_ms": 0, "shape_hint": None, "full_output_path": None}
    if cwd:
        os.chdir(cwd)
    out, err = io.StringIO(), io.StringIO()
    start = time.time()
    error = None
    result = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                compiled = compile(code, "<cell>", "eval")
                result = eval(compiled, _ns)
                _ns["_"] = result
                if result is not None:
                    print(repr(result))
            except SyntaxError:
                exec(compile(code, "<cell>", "exec"), _ns)
    except Exception:
        error = {"ename": type(sys.exc_info()[1]).__name__, "evalue": str(sys.exc_info()[1]), "traceback": traceback.format_exc().rstrip()}
    stdout = out.getvalue()
    stderr = err.getvalue()
    hint = None
    full_path = None
    if len(stdout) > max_output or len(stderr) > max_output:
        if result is not None:
            hint = _shape_hint(result)
        stdout, p1 = _truncate(stdout, max_output, tmp_dir, seq)
        stderr, p2 = _truncate(stderr, max_output, tmp_dir, seq)
        full_path = p1 or p2
    return {
        "stdout": stdout,
        "stderr": stderr,
        "error": error,
        "duration_ms": int((time.time() - start) * 1000),
        "audit": list(_ns.get("_AUDIT", [])),
        "sk_errors": list(_sk_errors),
        "shape_hint": hint,
        "full_output_path": full_path,
    }

def reload_skills(new_paths=None, new_imports=None):
    """Re-import every mounted skill module and return per-module status.
    With new_paths/new_imports, the mount set is replaced first (per-cwd
    re-resolve: sys.path updated, deselected bindings dropped)."""
    _sk_errors.clear()
    _reload_skills(new_paths, new_imports)
    status = {}
    for _name in (new_imports if new_imports is not None else (os.environ.get("PI_SKILL_IMPORTS", "") or "").split(",")):
        _name = (_name or "").strip()
        if not _name:
            continue
        status[_name] = "ok" if _name in _ns else "error"
    return status

def main():
    sys.stdout.write(json.dumps({"ready": True, "python": sys.version.split()[0]}) + "\\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({"seq": None, "stdout": "", "stderr": f"bad request: {e}", "error": None, "duration_ms": 0}) + "\\n")
            sys.stdout.flush()
            continue
        res = run_cell(req.get("code") or "", bool(req.get("reset")), req.get("cwd"),
                       req.get("seq"), req.get("max_output") or 20000, os.environ.get("PI_KERNEL_TMP", ""))
        if req.get("reload_skills"):
            res["reload_skills"] = reload_skills(req.get("skill_paths"), req.get("skill_imports"))
        res["seq"] = req.get("seq")
        sys.stdout.write(json.dumps(res) + "\\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
`.trim();

const DEFAULT_PYTHON_BIN = "python3";
const DEFAULT_CELL_TIMEOUT_MS = 120_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT = 200_000;

export interface CellResult {
	seq?: number;
	stdout: string;
	stderr: string;
	error: { ename: string; evalue: string; traceback: string } | null;
	duration_ms: number;
	/** Kernel-side mutation audit entries (xtrm-h7uwi.3 convention: _AUDIT list). */
	audit?: Array<Record<string, unknown>>;
	/** Per-module import status at boot and after reload_skills (xtrm-h7uwi.1). */
	sk_errors?: Array<Record<string, string>>;
	/** reload_skills request result (xtrm-h7uwi.1). */
	reload_skills?: Record<string, string>;
	/** Object-shape hint for a truncated result (xtrm-h7uwi.2). */
	shape_hint?: string | null;
	/** Temp file holding the full untruncated output (xtrm-h7uwi.2). */
	full_output_path?: string | null;
}

export interface PythonKernelOptions {
	/** Interpreter binary; default "python3" (must be on PATH). */
	pythonBin?: string;
	/** Per-cell timeout; default 120s. */
	cellTimeoutMs?: number;
	/** Driver-ready timeout; default 10s. */
	startTimeoutMs?: number;
	/** Per-cell output cap (chars); default 20KB. Over-cap output is head+marker+tail, full copy to a temp file. */
	maxOutputBytes?: number;
}

/**
 * Truncate text that exceeds maxChars: head + marker + tail (xtrm-h7uwi.2).
 * Pure and unit-testable; the driver mirrors this logic for the kernel side.
 */
export function truncateOutput(text: string, maxChars: number): { text: string; truncated: boolean; originalLength: number } {
	if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
	const headN = 8_192;
	const tailN = 4_096;
	const marker = `\n...[truncated ${text.length} chars]...\n`;
	return { text: text.slice(0, headN) + marker + text.slice(-tailN), truncated: true, originalLength: text.length };
}

// skillbridge (xtrm-h7uwi.1): an importable skill module selected from explicit
// roots. Convention (prime-agent Agent Skills): a direct child directory with
// SKILL.md. Canonical identity is the SKILL.md frontmatter `name:` (the
// runtimeName), else the skill directory name — never derived from src/.
// Whether the skill is python-backed (src/<package>/__init__.py) is
// a post-selection classifier recorded as importName: it never filters
// selection and never supplies identity.
export interface SkillModule {
	/** Canonical identity: SKILL.md frontmatter `name:`, else the skill directory name. */
	name: string;
	/** Python import name (the package dir under src/) for sys.path/pre-import transport. */
	importName: string;
	/** The root to prepend to sys.path: <skillDir>/src (parent of the package). */
	path: string;
	/** SKILL.md frontmatter description, first line, trimmed. */
	blurb: string;
}

/**
 * Explicit env override roots (lowest precedence; never primary discovery).
 * Canonical selection (PACK/state/active) is owned by the resolver (sibling):
 * callers pass canonical roots first and append these last. Home pointers are
 * never scanned.
 */
export function skillRoots(): string[] {
	const fromEnv = [
		...((process.env.PI_SKILL_PATHS ?? "") ? (process.env.PI_SKILL_PATHS ?? "").split(delimiter) : []),
		...((process.env.PI_SKILL_ROOTS ?? "") ? (process.env.PI_SKILL_ROOTS ?? "").split(delimiter) : []),
	];
	return fromEnv.map((r) => r.trim()).filter((r) => r.length > 0);
}

/**
 * Select skills from EXPLICIT roots (SKILL.md direct children). Roots are
 * processed in the caller's canonical order; the same runtimeName selected
 * from two different skill dirs is a loud collision (throws) — never silent
 * first-wins. Callers must not pass overlapping roots.
 */
export function discoverSkillModules(roots: readonly string[]): SkillModule[] {
	const found: SkillModule[] = [];
	const seenDirs = new Map<string, string>();
	for (const root of roots) {
		let entries: string[] = [];
		try {
			entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
		} catch {
			continue;
		}
		for (const dirName of entries.sort()) {
			const skillDir = join(root, dirName);
			const skillMd = join(skillDir, "SKILL.md");
			// Broken links have no SKILL.md and self-skip (never fatal).
			if (!existsSync(skillMd)) continue;
			const runtimeName = skillRuntimeName(skillMd, dirName);
			const first = seenDirs.get(runtimeName);
			if (first !== undefined) {
				if (first === skillDir) continue;
				throw new Error(
					`Skill name collision: '${runtimeName}' is selected from both ${first} and ${skillDir}; remove or rename one.`,
				);
			}
			seenDirs.set(runtimeName, skillDir);
			// Post-selection classifier: python-backed (src/<package>/) or not.
			// Non-python skills are selected (they reserve the name above) but
			// never mounted — the kernel only pre-imports python modules.
			const importName = findPackageName(join(skillDir, "src"));
			if (!importName) continue;
			found.push({
				name: runtimeName,
				importName,
				path: join(skillDir, "src"),
				blurb: skillBlurb(skillMd),
			});
		}
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Canonical identity: SKILL.md frontmatter `name:`, else the directory name. */
export function skillRuntimeName(skillMd: string, fallback: string): string {
	try {
		const text = readFileSync(skillMd, "utf8");
		const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const block = frontmatter ? frontmatter[1] : "";
		const line = block.split(/\r?\n/).find((l) => /^name\s*:/.test(l));
		const value = line ? line.replace(/^name\s*:/, "").trim().replace(/^["']|["']$/g, "").trim() : "";
		return value || fallback;
	} catch {
		return fallback;
	}
}

/** Classify the importable package directly under src (exactly one __init__.py package). */
function findPackageName(srcDir: string): string | undefined {
	let childDirs: string[] = [];
	try {
		childDirs = readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return undefined;
	}
	const candidates = childDirs.filter((d) => existsSync(join(srcDir, d, "__init__.py")));
	return candidates.length === 1 ? candidates[0] : undefined;
}

/** Extract the `description:` line from a SKILL.md frontmatter block, if present. */
export function skillBlurb(skillMd: string): string {
	try {
		const text = readFileSync(skillMd, "utf8");
		const m = text.match(/^description:\s*(.+)$/m);
		return m ? m[1].trim() : "";
	}
	catch {
		return "";
	}
}

// per-cwd mount (CORE-2511 merge): canonical pi-selection resolver lives in
// ./select-python-backed-skills.ts (CORE-2512, the ONE resolver). This module
// owns transport (SkillModule, explicit env roots, per-cwd kernel mounts) and
// adapts the canonical selection — it never re-scans raw roots, never
// re-implements precedence/collision for the canonical tiers.

/** Clear the canonical selection cache (tests + explicit invalidation). */
export function clearSelectionCache(): void {
	clearCanonicalSelectionCache();
}

/**
 * Canonical pi-selection for a cwd, adapted to SkillModule transport.
 * Canonical tiers (default + enabled packs, project + global) come from the
 * ONE resolver; explicit PI_SKILL_* roots are lowest precedence and never
 * override a canonical importName. Cross-scope collisions already throw
 * inside the canonical selectors.
 */
export async function selectPythonBackedSkills(cwd: string): Promise<SkillModule[]> {
	const canonical = await selectCanonicalPythonBackedSkills({ cwd, runtime: "pi" });
	const seenImport = new Set<string>();
	const modules: SkillModule[] = [];
	for (const skill of canonical) {
		if (seenImport.has(skill.importName)) continue;
		seenImport.add(skill.importName);
		modules.push({
			name: skill.runtimeName,
			importName: skill.importName,
			path: skill.srcRoot,
			blurb: skillBlurb(join(skill.skillDir, "SKILL.md")),
		});
	}
	const extraRoots = skillRoots();
	if (extraRoots.length > 0) {
		for (const mod of discoverSkillModules(extraRoots)) {
			if (seenImport.has(mod.importName)) continue;
			seenImport.add(mod.importName);
			modules.push(mod);
		}
	}
	return modules.sort((a, b) => a.name.localeCompare(b.name));
}

// kernel binding (xtrm-6z6.4): service_knowledge in-kernel.
// When the cwd carries a service registry (the same gating signal the
// service-knowledge extension uses), the driver pre-imports the installed
// `service_knowledge` Python package so drift checks + index rebuild run from
// one cell instead of CLI round trips.

/** Canonical service-knowledge registry roots (mirror find_umbrella_packs). */
function registryRoots(cwd: string): string[] {
	return [join(cwd, ".xtrm", "skills"), join(cwd, ".xtrm", "skills", "user", "packs")];
}

const RESERVED_PACK_NAMES = new Set(["default", "optional", "user", "active", "local-legacy"]);

/** True when cwd carries a canonical service-knowledge or legacy service-skills registry. */
export function hasServiceRegistry(cwd: string): boolean {
	for (const root of registryRoots(cwd)) {
		let names: string[] = [];
		try {
			names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			continue;
		}
		for (const name of names) {
			if (RESERVED_PACK_NAMES.has(name)) continue;
			const packDir = join(root, name);
			for (const umbrella of ["service-knowledge", "service-skills"]) {
				if (existsSync(join(packDir, umbrella, "service-registry.json"))) return true;
			}
		}
	}
	return false;
}

/**
 * Resolve the installed `service_knowledge` package location via the kernel's
 * own interpreter (venv-aware: uses the same pythonBin the kernel spawns).
 * Returns the directory to prepend to sys.path (parent of the package), or
 * null when the package is not importable.
 */
export async function resolveServiceKnowledgePath(pythonBin: string): Promise<string | null> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		const { stdout } = await execFileAsync(
			pythonBin,
			["-c", "import service_knowledge, os; print(os.path.dirname(os.path.dirname(service_knowledge.__file__)))"],
			{ timeout: 10_000 },
		);
		const path = stdout.trim();
		return path && existsSync(path) ? path : null;
	} catch {
		return null;
	}
}

export class PythonKernel {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private tmpDir: string | undefined;
	private buf = "";
	private waiters: Array<(r: CellResult) => void> = [];
	private nextSeq = 1;
	private started: Promise<void> | undefined;
	private readyResolve: (() => void) | undefined;
	private readyReject: ((e: Error) => void) | undefined;
	private readyTimer: ReturnType<typeof setTimeout> | undefined;
	private stderrBuf = "";
	private crashed = false;
	private lastSpawnError: string | undefined;
	private readonly pythonBin: string;
	private readonly cellTimeoutMs: number;
	private readonly startTimeoutMs: number;
	private readonly maxOutputChars: number;
	private skills: SkillModule[];
	private readonly skPackagePath: string | null;

	constructor(
		private readonly cwd: string,
		private readonly onRestart: (message: string) => void,
		options: PythonKernelOptions = {},
		skills: SkillModule[] = [],
		skPackagePath: string | null = null,
	) {
		this.pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
		this.cellTimeoutMs = options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.maxOutputChars = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_CHARS;
		this.skills = skills;
		this.skPackagePath = skPackagePath;
	}

	ensureStarted(): Promise<void> {
		if (!this.started) {
			this.started = this.spawn();
		}
		return this.started;
	}

	private async spawn(): Promise<void> {
		this.lastSpawnError = undefined;
		const tmpDir = await mkdtemp(join(tmpdir(), "pi-py-kernel-"));
		this.tmpDir = tmpDir;
		const driverPath = join(tmpDir, "driver.py");
		await writeFile(driverPath, DRIVER, "utf8");
		this.buf = "";
		this.waiters = [];
		this.stderrBuf = "";
		this.crashed = false;
		this.nextSeq = 1;

		const proc = spawn(this.pythonBin, ["-u", driverPath], {
			cwd: this.cwd,
			env: {
				...process.env,
				...(this.skills.length > 0
					? {
							// skillbridge: mount roots on sys.path and pre-import modules into _ns.
							PI_SKILL_PATHS: [...new Set(this.skills.map((s) => s.path))].join(":"),
							PI_SKILL_IMPORTS: this.skills.map((s) => s.importName).join(","),
						}
					: {}),
				// kernel binding (xtrm-6z6.4): when a service registry is present,
				// the driver pre-imports the installed service_knowledge package.
				...(this.skPackagePath ? { PI_SK_PACKAGE_PATH: this.skPackagePath } : {}),
				// QoL: full over-cap cell output is written into the kernel temp dir
				// (path surfaces in the reply; removed with the kernel on teardown).
				PI_KERNEL_TMP: this.tmpDir ?? "",
			},
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group so we can kill code-spawned children too.
			detached: true,
		});
		this.proc = proc;

		// Dead children (e.g. ENOENT) close their stdio streams; swallow the
		// resulting stream errors so they never become unhandled 'error' events.
		proc.stdin.on("error", () => {});
		proc.stdout.on("error", () => {});
		proc.stderr.on("error", () => {});

		// xtrm-3ljgz.1: a missing/unlaunchable interpreter surfaces as an
		// 'error' event on the child (ENOENT etc.). Without a handler this
		// would be an unhandled 'error' event crash; instead record the cause
		// and fail every pending call so it turns into a structured tool error.
		proc.on("error", (err) => {
			if (this.proc !== proc) return;
			this.proc = undefined;
			this.started = undefined;
			this.crashed = true;
			this.lastSpawnError = `${this.pythonBin} failed to start: ${err.message}`;
			this.failAll(new Error(this.lastSpawnError));
			this.rejectReady(new Error(this.lastSpawnError));
			this.removeTmpDir();
		});

		proc.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
		proc.stderr.on("data", (d: Buffer) => {
			this.stderrBuf = (this.stderrBuf + d.toString()).slice(-16_384);
		});
		proc.on("exit", (code, signal) => {
			if (this.proc !== proc) return;
			this.proc = undefined;
			this.started = undefined;
			this.crashed = true;
			this.failAll(new Error(`python kernel exited (${signal ?? code})`));
			// Clear the pending start-timeout so a stale timer from this dead
			// spawn cannot kill a later, healthy kernel (xtrm-3ljgz review).
			if (this.readyTimer) {
				clearTimeout(this.readyTimer);
				this.readyTimer = undefined;
			}
			this.removeTmpDir();
		});

		this.readyTimer = setTimeout(() => {
			this.rejectReady(new Error(`${this.pythonBin} kernel did not start in time`));
		}, this.startTimeoutMs);
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i).trim();
			this.buf = this.buf.slice(i + 1);
			if (!line) continue;
			let msg: { ready?: boolean; python?: string } | CellResult;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // not protocol JSON; ignore
			}
			if ("ready" in msg && msg.ready) {
				this.resolveReady();
				continue;
			}
			const waiter = this.waiters.shift();
			if (waiter) waiter(msg as CellResult);
		}
	}

	private resolveReady(): void {
		if (this.readyTimer) clearTimeout(this.readyTimer);
		this.readyResolve?.();
		this.readyResolve = undefined;
		this.readyReject = undefined;
	}

	private rejectReady(e: Error): void {
		this.readyReject?.(e);
		this.readyResolve = undefined;
		this.readyReject = undefined;
		this.kill();
	}

	private failAll(e: Error): void {
		this.readyReject?.(e);
		this.readyResolve = undefined;
		this.readyReject = undefined;
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) {
			// Reject is not representable in the waiter tuple type; route through a
			// killed cell result instead so pending calls fail with the crash.
			w({
				seq: undefined,
				stdout: "",
				stderr: e.message,
				error: { ename: "KernelExited", evalue: e.message, traceback: "" },
				duration_ms: 0,
			});
		}
	}

	runCell(code: string, reset: boolean, cwd?: string): Promise<CellResult> {
		return this.ensureStarted().then(() => {
			if (this.lastSpawnError) throw new Error(this.lastSpawnError);
			if (!this.proc) {
				throw new Error(this.lastSpawnError ?? `${this.pythonBin} kernel is not running`);
			}
			const seq = this.nextSeq++;
			return new Promise<CellResult>((resolve) => {
				const timer = setTimeout(() => {
					const message = `python cell timed out after ${this.cellTimeoutMs / 1000}s`;
					// Report the timeout to THIS cell before kill() drains it, so the
					// caller sees a clear timed-out error instead of the generic killed
					// result (xtrm-3ljgz review residual).
					resolve({
						seq: undefined,
						stdout: "",
						stderr: `${message} (kernel killed; state lost — the next call restarts it)`,
						error: { ename: "KernelTimeout", evalue: message, traceback: "" },
						duration_ms: 0,
					});
					this.kill(); // cell still running; drop the kernel and its process group
				}, this.cellTimeoutMs);
				this.waiters.push((r) => {
					clearTimeout(timer);
					resolve(r);
				});
				this.proc!.stdin.write(JSON.stringify({ seq, code, reset, cwd, max_output: this.maxOutputChars }) + "\n");
			});
		});
	}

	/** Reload mounted skill modules; with fresh modules the mount set is
	 * replaced first (re-resolve then re-import: deselected roots leave
	 * sys.path and deselected bindings leave the namespace). */
	async reloadSkills(freshModules?: SkillModule[]): Promise<Record<string, string>> {
		await this.ensureStarted();
		if (!this.proc) throw new Error(this.lastSpawnError ?? `${this.pythonBin} kernel is not running`);
		const seq = this.nextSeq++;
		const payload: Record<string, unknown> =
			freshModules !== undefined
				? {
						seq,
						reload_skills: true,
						skill_paths: [...new Set(freshModules.map((s) => s.path))],
						skill_imports: freshModules.map((s) => s.importName),
					}
				: { seq, reload_skills: true };
		return new Promise<Record<string, string>>((resolve, reject) => {
			const timer = setTimeout(() => {
				const message = `skill reload timed out after ${this.cellTimeoutMs / 1000}s`;
				reject(new Error(message));
				this.kill();
			}, this.cellTimeoutMs);
			this.waiters.push((r) => {
				clearTimeout(timer);
				if (r.error) reject(new Error(`${r.error.ename}: ${r.error.evalue}`));
				else {
					if (freshModules !== undefined) this.skills = [...freshModules];
					resolve(r.reload_skills ?? {});
				}
			});
			this.proc!.stdin.write(JSON.stringify(payload) + "\n");
		});
	}

	kill(): void {
		const proc = this.proc;
		this.proc = undefined;
		this.started = undefined;
		if (this.readyTimer) clearTimeout(this.readyTimer);
		// Drain pending cells so an aborted call fails immediately, not at the timeout.
		const waiters = this.waiters;
		this.waiters = [];
		const killed: CellResult = {
			seq: undefined,
			stdout: "",
			stderr: "kernel killed",
			error: { ename: "KernelKilled", evalue: "kernel killed", traceback: "" },
			duration_ms: 0,
		};
		for (const w of waiters) w(killed);
		if (proc?.pid) {
			try {
				process.kill(-proc.pid, "SIGKILL"); // process group: kills code-spawned children
			} catch {
				// already gone
			}
		}
		this.removeTmpDir();
	}

	private removeTmpDir(): void {
		if (this.tmpDir) {
			void rm(this.tmpDir, { recursive: true, force: true });
			this.tmpDir = undefined;
		}
	}

	get crashedState(): boolean {
		return this.crashed;
	}

	get stderrDiagnostics(): string {
		return this.stderrBuf;
	}
}

export type KernelFactory = (cwd: string, sessionId: string) => PythonKernel;

export interface PythonKernelExtensionOptions {
	kernelFactory?: KernelFactory;
	/**
	 * audit seam (xtrm-h7uwi.3): enable the mutation policy hook. Off by
	 * default — convention-first, no enforcement ships until the hook has
	 * proven itself. When on, audit entries whose path lies outside the
	 * session cwd are flagged in the tool result (report-only, never blocks).
	 */
	auditPolicy?: boolean;
}

export default function pythonKernelExtension(pi: ExtensionAPI, opts: PythonKernelExtensionOptions = {}) {
	const kernels = new Map<string, { kernel: PythonKernel; cwd: string; factoryMade: boolean }>();
	// audit seam: flag is opt-in via code, but also honor PI_KERNEL_AUDIT_POLICY
	// so headless e2e smoke can exercise the policy hook without code changes.
	const auditPolicy = opts.auditPolicy === true || process.env.PI_KERNEL_AUDIT_POLICY === "1";

	// skillbridge: no static scan at init. Selection is per-cwd from the
	// canonical resolver (CORE-2512); explicit PI_SKILL_* roots are lowest
	// precedence. The bundled ./skills tree is build-time source only — never
	// a runtime scan root — and home pointers are never scanned.

	// kernel binding (xtrm-6z6.4): per-cwd service_knowledge package path cache.
	// Registry presence is per-repo (sessions can be in different cwds), so it is
	// resolved lazily per cwd, not at extension init.
	const skPathCache = new Map<string, Promise<string | null>>();
	function resolveSkPathFor(cwd: string): Promise<string | null> {
		let p = skPathCache.get(cwd);
		if (!p) {
			p = (async () => {
				if (!hasServiceRegistry(cwd)) return null;
				return resolveServiceKnowledgePath(process.env.PI_PYTHON_BIN ?? "python3");
			})();
			skPathCache.set(cwd, p);
		}
		return p;
	}

	// per-cwd mount: the pi-selection for ctx.cwd is resolved per session —
	// never once at extension init. Different cwds mount different selections;
	// toggling enabledPacks changes next-session mounts via the canonical
	// selector's state.json mtime invalidation. Forensics mounts via its
	// vendored optional-tier pack when enabled, never via a bundled scan.
	async function kernelFor(cwd: string, sessionId: string): Promise<PythonKernel> {
		const seen = kernels.get(sessionId);
		if (seen && resolve(seen.cwd) === resolve(cwd)) return seen.kernel;
		if (seen) {
			seen.kernel.kill();
			kernels.delete(sessionId);
		}
		if (opts.kernelFactory) {
			const kernel = opts.kernelFactory(cwd, sessionId);
			kernels.set(sessionId, { kernel, cwd, factoryMade: true });
			return kernel;
		}
		const [selection, skPath] = await Promise.all([selectPythonBackedSkills(cwd), resolveSkPathFor(cwd)]);
		const kernel = new PythonKernel(cwd, () => {}, {}, selection, skPath);
		kernels.set(sessionId, { kernel, cwd, factoryMade: false });
		return kernel;
	}

	pi.registerTool({
		name: "python",
		label: "Python (persistent kernel)",
		description:
			"Execute Python code in a persistent interpreter. Variables, imports, and functions persist across calls until reset: true. Code runs with your user permissions and is not sandboxed — treat a cell like any shell command. For a project's own tests, scripts, and CLIs use the project's documented environment instead." +
			"\nSession scratch: kernel state lives with the session and dies with it (timeout kill, reset, session end). Findings that must survive go to files/bd/journal; the kernel holds working state only." +
			"\nOne cell per question: capture via subprocess inside the cell and parse in the same cell — a shell+compute round-trip pair collapses to one call. Expression results also land in `_`." +
			"\nPrelude pre-loaded: json, re, os, sys, subprocess, Path (from pathlib)." +
			"\nPrelude functions: preflight(repo, path, n=4) — file-scoped memory retrieval for one file: git log --follow with bodies, pending diff --stat, bd memory keys; prints a bounded digest and stashes records in _preflight_cache[(repo, path)]. Run before editing flagged files; 0 commits means wrong path. kns() — namespace mirror (name -> shape hint); run when resuming or after long threads instead of re-deriving." +
			"\nSkill modules mount per-cwd from the canonical pi-selection (python-backed members only, pre-imported in namespace); reload_skills re-resolves the selection then re-imports. help(x) for docs.",

		promptSnippet: "python - run code in a persistent kernel; state survives across calls",
		promptGuidelines: [
			"Use python for multi-step processing, parsing, aggregation, and fan-out: one cell replaces many round trips, and named variables persist across cells. Capture via subprocess inside the cell and parse in the same cell — one cell per question; expression results land in `_`.",
			"preflight(repo, path) is bound at boot: file-scoped memory retrieval (commits with bodies, pending diff, bd memory keys) before editing a flagged file; prints a digest, never the raw corpus; 0 commits means wrong path.",
			"Memory retrieval, not just compute: retrieve on demand per flagged file via preflight, never bulk; non-file forensics loads the corpus once into a named variable, then filters across cells.",
			"python state persists across calls (variables, imports, functions); pass reset: true to clear it.",
			"os.chdir() inside a cell persists; reset returns to the working directory.",
			"Code runs with your user permissions and is not sandboxed; treat a cell like a shell command.",
			"For a project's own tests, scripts, and CLIs, use the project's documented environment (uv run, .venv/bin/python, npm run) rather than the kernel.",
			"kns() mirrors the namespace (name -> shape hint); run it when resuming or after long threads instead of re-deriving. Kernel state is session scratch — promote findings to files/bd/journal.",
		],
		executionMode: "sequential",
		// CORE-2358: without a renderCall Pi falls back to a 100-char
		// JSON preview of args — the executed code is effectively hidden.
		// Show it the way bash shows its command: the full text.
		renderCall: (args, theme) => {
			const code = String((args as { code?: unknown }).code ?? "");
			const head = theme.fg("toolTitle", theme.bold("python"));
			if (!code) return new Text(head, 0, 0);
			const lines = code.split("\n").map((l) => `  ${theme.fg("muted", l)}`);
			return new Text([head, ...lines].join("\n"), 0, 0);
		},
		parameters: Type.Object({
			code: Type.String({ description: "Python code to execute in the persistent kernel." }),
			reset: Type.Optional(
				Type.Boolean({ description: "Clear the kernel namespace and return to the working directory." }),
			),
			reload_skills: Type.Optional(
				Type.Boolean({ description: "Re-resolve the canonical pi-selection for the session cwd, then re-import every mounted skill module and refresh the namespace." }),
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			const kernel = await kernelFor(ctx.cwd, sessionId);
			const onAbort = () => kernel.kill();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				if (params.reload_skills === true) {
					// per-cwd mount: re-resolve the canonical selection for the
					// session cwd, then re-import. Factory-made kernels (tests)
					// keep legacy same-set re-import semantics.
					const entry = kernels.get(sessionId);
					const status =
						entry && !entry.factoryMade
							? await kernel.reloadSkills(await selectPythonBackedSkills(ctx.cwd))
							: await kernel.reloadSkills();
					const failed = Object.entries(status).filter(([, s]) => s !== "ok");
					const lines = Object.entries(status).map(([n, s]) => `${n}: ${s}`);
					return {
						content: [{ type: "text", text: `reload_skills: ${lines.join(", ") || "(no modules)"}` }],
						details: { status: failed.length > 0 ? "error" : "ok", reload_skills: status },
						isError: failed.length > 0,
					};
				}

				const result = await kernel.runCell(params.code, params.reset === true, params.reset ? ctx.cwd : undefined);

				let text = result.stdout;
				if (result.stderr) text += (text ? "\n" : "") + result.stderr;
				if (result.error) {
					text += (text ? "\n" : "") + result.error.traceback;
				}
				if (result.shape_hint) {
					text = `[output truncated: ${result.shape_hint}]\n` + text;
				}
				if (result.full_output_path) {
					text += `\n[full output: ${result.full_output_path}]`;
				}
				if (kernel.crashedState && result.error?.ename === "KernelExited") {
					text = `[python kernel crashed; prior state is lost — it restarts on the next call]\n\n` + text;
				}

				// audit seam (xtrm-h7uwi.3): surface kernel-side mutation entries in
				// the tool details; the policy hook (behind the auditPolicy flag)
				// gets first look before any enforcement ships. Convention-first.
				const audit = result.audit ?? [];
				let policy = "none";
				if (auditPolicy && audit.length > 0) {
					const blocked = audit.filter((entry) => {
						const p = typeof entry?.path === "string" ? entry.path : "";
						return p && !p.startsWith(ctx.cwd);
					});
					if (blocked.length > 0) {
						policy = `blocked ${blocked.length} out-of-session writes`;
						text += `\n[audit policy] blocked ${blocked.length} mutation(s) outside session cwd:\n` + JSON.stringify(blocked, null, 2);
					} else {
						policy = `allowed ${audit.length} mutations`;
					}
				}

				return {
					content: [{ type: "text", text: text || "(no output)" }],
					details: {
						status: result.error ? "error" : "ok",
						stdout: result.stdout,
						stderr: result.stderr,
						durationMs: result.duration_ms,
						error: result.error ?? undefined,
						audit: audit.length > 0 ? audit : undefined,
						auditPolicy: policy,
					},
					isError: result.error !== null,
				};
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				const diag = kernel.stderrDiagnostics ? `\n[kernel stderr] ${kernel.stderrDiagnostics}` : "";
				return {
					content: [{ type: "text", text: `python error: ${message}${diag}` }],
					details: { status: "error", error: { ename: "ToolError", evalue: message, traceback: "" } },
					isError: true,
				};
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});

	// Clean up kernels when the session ends.
	pi.on("session_shutdown", async () => {
		for (const { kernel } of kernels.values()) {
			kernel.kill();
		}
		kernels.clear();
	});
}
