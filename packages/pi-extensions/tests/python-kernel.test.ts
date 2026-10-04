import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Pi host provides typebox at runtime; tests substitute a structural
// stand-in that records the parameter schema shape (xtrm-3ljgz.1).
mock.module("typebox", () => ({
  Type: {
    Object: (shape: unknown) => ({ kind: "object", shape }),
    String: (opts: unknown) => ({ kind: "string", opts }),
    Boolean: (opts: unknown) => ({ kind: "boolean", opts }),
    Optional: (t: unknown) => ({ kind: "optional", t }),
  },
}));

const extension = await import("../extensions/python-kernel/index.ts");
const { PythonKernel } = extension;

function tmpBase() {
  const dir = mkdtempSync(join(tmpdir(), "pi-py-kernel-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a python-backed skill fixture: SKILL.md + src/<name>/__init__.py. */
function writeFixtureSkill(root: string, name: string, body: string) {
  const skillDir = join(root, name);
  mkdirSync(join(skillDir, "src", name), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\ndescription: ${name} test skill\n---\n`);
  writeFileSync(join(skillDir, "src", name, "__init__.py"), body);
  return skillDir;
}

function fakePi() {
  const tools: any[] = [];
  const listeners = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
  return {
    registerTool(def: any) {
      tools.push(def);
    },
    on(event: string, cb: (event: any, ctx: any) => Promise<void>) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    },
    tools,
    listeners,
  };
}

function runViaExecute(tool: any, params: any, signal?: AbortSignal) {
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "test-session" } };
  return tool.execute("test-call", params, signal, () => {}, ctx);
}

describe("python-kernel managed extension", () => {
  test("registers exactly one sequential python tool with kernel doctrine", () => {
    const pi = fakePi();
    extension.default(pi as any);

    expect(pi.tools).toHaveLength(1);
    const tool = pi.tools[0];
    expect(tool.name).toBe("python");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptSnippet).toContain("state survives across calls");
    expect(tool.promptGuidelines.join("\n")).toContain("python state persists across calls");
    expect(tool.promptGuidelines.join("\n")).toContain("reset: true");
    // Review residual: metadata must state the trust boundary explicitly.
    expect(tool.description).toContain("user permissions");
    expect(tool.description).toContain("not sandboxed");
    expect(tool.promptGuidelines.join("\n")).toContain("user permissions");
    expect(tool.promptGuidelines.join("\n")).toContain("not sandboxed");
    expect(tool.parameters.kind).toBe("object");
    expect(tool.parameters.shape.code.kind).toBe("string");
    expect(tool.parameters.shape.reset.kind).toBe("optional");
    expect(tool.parameters.shape.reload_skills.kind).toBe("optional");
  });

  test("skillbridge discovery scans skills roots for python-backed skills", () => {
    const fx = tmpBase();
    try {
      writeFixtureSkill(fx.dir, "alpha", "VALUE = 1\n");
      writeFixtureSkill(fx.dir, "beta", "VALUE = 2\n");
      // Not python-backed: no src/<name>/__init__.py.
      mkdirSync(join(fx.dir, "plain"));
      writeFileSync(join(fx.dir, "plain", "SKILL.md"), "---\ndescription: no python\n---\n");

      const modules = extension.discoverSkillModules([fx.dir]);
      expect(modules.map((m) => m.name).sort()).toEqual(["alpha", "beta"]);
      for (const m of modules) {
        expect(m.path).toBe(join(fx.dir, m.name, "src"));
        expect(m.blurb).toContain("test skill");
      }
    } finally {
      fx.cleanup();
    }
  });

  test("skillbridge discovery: import name is the package dir, not the skill dir (xtrm-vs7f8)", () => {
    const fx = tmpBase();
    try {
      // Skill dir is 'fiskill' but the importable package is src/sre_chain.
      const skillDir = join(fx.dir, "fiskill");
      mkdirSync(join(skillDir, "src", "sre_chain"), { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: e2e fixture\n---\n");
      writeFileSync(join(skillDir, "src", "sre_chain", "__init__.py"), "VALUE = 1\n");

      const modules = extension.discoverSkillModules([fx.dir]);
      expect(modules).toHaveLength(1);
      // The description must list the ACTUAL import name (what the kernel mounts).
      expect(modules[0].name).toBe("sre_chain");
      expect(modules[0].path).toBe(join(skillDir, "src"));
    } finally {
      fx.cleanup();
    }
  });

  test("skillbridge mounts fixture skills as importable kernel modules (no host round trips)", async () => {
    const fx = tmpBase();
    try {
      writeFixtureSkill(fx.dir, "sre_chain", "def load(): return 'loaded'\ndef run(dry_run=False): return dry_run\n");
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [
        { name: "sre_chain", path: join(fx.dir, "sre_chain", "src"), blurb: "fixture" },
      ]);
      // Import happens at boot; the module is bound into _ns, so a bare name
      // reference works with zero host round trips.
      const call = await kernel.runCell("sre_chain.load()", false);
      expect(call.error).toBeNull();
      expect(call.stdout.trim()).toBe("'loaded'");
      const call2 = await kernel.runCell("sre_chain.run(dry_run=True)", false);
      expect(call2.error).toBeNull();
      expect(call2.stdout.trim()).toBe("True");
      expect(call2.sk_errors).toEqual([]);
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("skillbridge reload re-imports a skill module and reflects changes", async () => {
    const fx = tmpBase();
    try {
      const skill = writeFixtureSkill(fx.dir, "reloadme", "VALUE = 'old'\n");
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [
        { name: "reloadme", path: join(fx.dir, "reloadme", "src"), blurb: "fixture" },
      ]);
      const first = await kernel.runCell("reloadme.VALUE", false);
      expect(first.stdout.trim()).toBe("'old'");

      writeFileSync(join(skill, "src", "reloadme", "__init__.py"), "VALUE = 'new'\n");
      const status = await kernel.reloadSkills();
      expect(status).toEqual({ reloadme: "ok" });
      const second = await kernel.runCell("reloadme.VALUE", false);
      expect(second.stdout.trim()).toBe("'new'");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("skillbridge boot survives a broken skill and surfaces _sk_errors", async () => {
    const fx = tmpBase();
    try {
      writeFixtureSkill(fx.dir, "good", "VALUE = 1\n");
      writeFixtureSkill(fx.dir, "bad", "raise RuntimeError('boom')\n");
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [
        { name: "good", path: join(fx.dir, "good", "src"), blurb: "fixture" },
        { name: "bad", path: join(fx.dir, "bad", "src"), blurb: "fixture" },
      ]);
      // Boot must not die; the good module still imports, the bad one is recorded.
      const call = await kernel.runCell("good.VALUE", false);
      expect(call.error).toBeNull();
      expect(call.stdout.trim()).toBe("1");
      expect(call.sk_errors).toHaveLength(1);
      expect(call.sk_errors![0].module).toBe("bad");
      expect(call.sk_errors![0].ename).toBe("RuntimeError");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("tool reload_skills param surfaces per-module status via the extension", async () => {
    const fx = tmpBase();
    try {
      writeFixtureSkill(fx.dir, "sre_chain", "def load(): return 'loaded'\n");
      const pi = fakePi();
      extension.default(pi as any, {
        kernelFactory: () =>
          new PythonKernel(fx.dir, () => {}, {}, [
            { name: "sre_chain", path: join(fx.dir, "sre_chain", "src"), blurb: "fixture" },
          ]),
      });
      const tool = pi.tools[0];
      const result = await runViaExecute(tool, { reload_skills: true });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("sre_chain: ok");
      expect(result.details.status).toBe("ok");
    } finally {
      fx.cleanup();
    }
  });

  test("kernel reply carries the skill import audit list for host visibility", async () => {
    const fx = tmpBase();
    try {
      writeFixtureSkill(fx.dir, "sre_chain", "def load(): return 'loaded'\n");
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [
        { name: "sre_chain", path: join(fx.dir, "sre_chain", "src"), blurb: "fixture" },
      ]);
      const call = await kernel.runCell("sre_chain.load()", false);
      expect(call.audit).toEqual([]); // no _AUDIT entries yet; field present
      expect(Array.isArray(call.audit)).toBe(true);
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("audit seam: kernel-side mutation entries flow into the reply and tool details", async () => {
    const fx = tmpBase();
    try {
      writeFixtureSkill(
        fx.dir,
        "mutator",
        "def write_file(path, content='x'):\n    _AUDIT.append({'op': 'write', 'path': path})\n    return 'wrote'\n",
      );
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [
        { name: "mutator", path: join(fx.dir, "mutator", "src"), blurb: "fixture" },
      ]);
      const call = await kernel.runCell("mutator.write_file('/etc/hosts')", false);
      expect(call.error).toBeNull();
      expect(call.audit).toHaveLength(1);
      expect(call.audit![0]).toEqual({ op: "write", path: "/etc/hosts" });
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("audit seam: policy hook (behind flag) flags out-of-session writes in the tool result", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {}, {}, []);
      const pi = fakePi();
      extension.default(pi as any, {
        auditPolicy: true,
        kernelFactory: () => kernel,
      });
      const tool = pi.tools[0];
      // Simulate a cell whose skill appended an out-of-session write to _AUDIT.
      await kernel.runCell("_AUDIT.append({'op': 'write', 'path': '/etc/hosts'})", false);
      const result = await runViaExecute(tool, { code: "'ok'" });
      expect(result.details.auditPolicy).toContain("blocked 1");
      expect(result.content[0].text).toContain("outside session cwd");
      // In-session writes are allowed when the hook is on. runViaExecute uses
      // ctx.cwd = process.cwd(), so an in-session path is under that cwd.
      const sessionCwd = process.cwd();
      await kernel.runCell(`_AUDIT.clear(); _AUDIT.append({'op': 'write', 'path': '${sessionCwd}/x.txt'})`, false);
      const result2 = await runViaExecute(tool, { code: "'ok'" });
      expect(result2.details.auditPolicy).toContain("allowed");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("audit seam: hook is off by default (no policy text, audit still in details)", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {}, {}, []);
      const pi = fakePi();
      extension.default(pi as any, { kernelFactory: () => kernel });
      const tool = pi.tools[0];
      await kernel.runCell("_AUDIT.append({'op': 'write', 'path': '/etc/hosts'})", false);
      const result = await runViaExecute(tool, { code: "'ok'" });
      expect(result.details.audit).toEqual([{ op: "write", path: "/etc/hosts" }]);
      expect(result.details.auditPolicy).toBe("none");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("kernel state persists across cells and reset clears it", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {});
      const first = await kernel.runCell("x = 41", false);
      expect(first.error).toBeNull();
      const second = await kernel.runCell("x + 1", false);
      expect(second.stdout.trim()).toBe("42");
      expect(second.error).toBeNull();
      const reset = await kernel.runCell("x = 0", true, fx.dir);
      expect(reset.error).toBeNull();
      expect(reset.stdout).toBe(""); // reset clears without executing the cell
      const afterReset = await kernel.runCell("x + 1", false);
      expect(afterReset.error?.ename).toBe("NameError");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("preflight: durable prelude binding, hermetic wrong-path guard, read-only digest", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {});
      // bound at boot
      const boot = await kernel.runCell("callable(preflight)", false);
      expect(boot.error).toBeNull();
      expect(boot.stdout.trim()).toBe("True");
      // hermetic: tmpdir has no git history -> the wrong-path guard fires, no raise
      const guard = await kernel.runCell(`preflight(${JSON.stringify(fx.dir)}, "nope.ts")`, false);
      expect(guard.error).toBeNull();
      expect(guard.stdout).toContain("0 commits");
      // memory topic: a generic module name keys nothing, so walk up to the
      // nearest meaningful directory ("index" -> "python-kernel").
      expect(guard.stdout).toContain("memory topic: nope");
      const generic = await kernel.runCell(
        `preflight(${JSON.stringify(fx.dir)}, "pkg/python-kernel/index.ts")`,
        false,
      );
      expect(generic.error).toBeNull();
      expect(generic.stdout).toContain("memory topic: python-kernel");
      const nested = await kernel.runCell(
        `preflight(${JSON.stringify(fx.dir)}, "pkg/xtrm-ui/index/main.ts")`,
        false,
      );
      expect(nested.stdout).toContain("memory topic: xtrm-ui");
      // durable: reset clears user state, prelude survives (xtrm-vs7f8 invariant)
      await kernel.runCell("x = 1", true, fx.dir);
      const after = await kernel.runCell("callable(preflight)", false);
      expect(after.error).toBeNull();
      expect(after.stdout.trim()).toBe("True");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("eval and exec semantics both work and exceptions carry traceback details", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {});
      const expr = await kernel.runCell("1 + 1", false);
      expect(expr.stdout.trim()).toBe("2");
      const stmt = await kernel.runCell("y = [i * i for i in range(3)]", false);
      expect(stmt.error).toBeNull();
      const boom = await kernel.runCell("raise ValueError('kernel boom')", false);
      expect(boom.error).not.toBeNull();
      expect(boom.error?.ename).toBe("ValueError");
      expect(boom.error?.traceback).toContain("ValueError");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("os.chdir persists and reset returns to the working directory", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {});
      const chdir = await kernel.runCell("import os; os.chdir('/tmp')", false);
      expect(chdir.error).toBeNull();
      const where = await kernel.runCell("os.getcwd()", false);
      expect(where.stdout.trim()).toBe("'/tmp'"); // eval path reprs string results
      await kernel.runCell("x_cwd = os.getcwd()", false);
      const reset = await kernel.runCell("x_cwd", true, fx.dir);
      expect(reset.error).toBeNull(); // reset does not execute the cell
      const cleared = await kernel.runCell("x_cwd", false);
      expect(cleared.error?.ename).toBe("NameError"); // namespace was cleared
      const back = await kernel.runCell("import os", false);
      expect(back.error).toBeNull();
      const backCwd = await kernel.runCell("os.getcwd()", false);
      expect(backCwd.stdout.trim()).toBe(`'${fx.dir}'`); // cwd reset to the working directory
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("missing python3 yields a structured tool error, never a crash", async () => {
    const fx = tmpBase();
    try {
      const pi = fakePi();
      const missingBin = join(fx.dir, "definitely-missing-python3");
      extension.default(pi as any, {
        kernelFactory: () => new PythonKernel(fx.dir, () => {}, {
          pythonBin: missingBin,
          startTimeoutMs: 2_000,
        }),
      });
      const tool = pi.tools[0];
      const result = await runViaExecute(tool, { code: "1 + 1" });
      expect(result.isError).toBe(true);
      expect(result.details.status).toBe("error");
      expect(result.content[0].text).toMatch(/failed to start|python/i);
    } finally {
      fx.cleanup();
    }
  });

  test("abort kills the kernel and pending cells fail immediately", async () => {
    const fx = tmpBase();
    try {
      const pi = fakePi();
      extension.default(pi as any);
      const tool = pi.tools[0];
      const controller = new AbortController();
      const pending = runViaExecute(tool, { code: "import time; time.sleep(30)" }, controller.signal);
      // Give the kernel a beat to start and begin the long cell.
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/kernel killed|timed out|exited/i);
    } finally {
      fx.cleanup();
    }
  });

  test("long cells time out with a clear structured error and drop the kernel", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {}, { cellTimeoutMs: 250 });
      const result = await kernel.runCell("import time; time.sleep(30)", false);
      // Review residual: the timed-out cell must report a timeout, not the
      // generic killed result that kill() would otherwise produce.
      expect(result.error?.ename).toBe("KernelTimeout");
      expect(result.stderr).toContain("timed out after 0.25s");
      // The next call must spawn a fresh kernel instead of reusing a dead one.
      const next = await kernel.runCell("1 + 1", false);
      expect(next.stdout.trim()).toBe("2");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("driver exit removes the temp dir and a later call retries on a fresh spawn", async () => {
    const fx = tmpBase();
    try {
      // Deterministic fail-once bin: exits 3 on the first spawn (marker
      // absent), then delegates to the real python3. No sleeps.
      const marker = join(fx.dir, "fail-marker");
      const bin = join(fx.dir, "python3-fail-once");
      writeFileSync(bin, `#!/bin/sh\nif [ -f "${marker}" ]; then exec python3 "$@"; fi\ntouch "${marker}"\nexit 3\n`);
      chmodSync(bin, 0o755);
      const kernel = new PythonKernel(fx.dir, () => {}, { pythonBin: bin, startTimeoutMs: 5_000 });

      const first = await kernel.runCell("1 + 1", false);
      expect(first.error?.ename).toBe("KernelExited");
      expect(first.stderr).toContain("exited (3)");
      // Crash/exit must remove the temp driver dir and reset startup state.
      expect((kernel as any).tmpDir).toBeUndefined();
      // The start-timeout timer from the dead spawn must be cleared too, so a
      // stale timer can never kill a later healthy kernel.
      expect((kernel as any).readyTimer).toBeUndefined();

      // A later call must retry from scratch and succeed.
      const second = await kernel.runCell("2 + 2", false);
      expect(second.error).toBeNull();
      expect(second.stdout.trim()).toBe("4");
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("session_shutdown cleans up kernels", async () => {
    const fx = tmpBase();
    try {
      const pi = fakePi();
      extension.default(pi as any);
      const tool = pi.tools[0];
      const first = await runViaExecute(tool, { code: "x = 1" });
      expect(first.isError).toBe(false);
      const shutdown = pi.listeners.get("session_shutdown");
      expect(shutdown).toBeDefined();
      await shutdown![0]({}, {});
      const after = await runViaExecute(tool, { code: "x" });
      expect(after.isError).toBe(true); // state was cleared by shutdown
      expect(after.content[0].text).toMatch(/NameError|python error/i);
    } finally {
      fx.cleanup();
    }
  });

  test("output truncation guards unbounded tool results with head+marker+tail and a temp file path", async () => {
    const fx = tmpBase();
    try {
      const pi = fakePi();
      extension.default(pi as any);
      const tool = pi.tools[0];
      const result = await runViaExecute(tool, { code: "print('x' * 300_000)" });
      expect(result.isError).toBe(false);
      // 300k chars → head 8k + marker + tail 4k ≈ 12.3k, well under the old 200k guard.
      expect(result.content[0].text.length).toBeLessThan(20_000);
      expect(result.content[0].text).toMatch(/\[truncated 3000\d+ chars\]/);
      // The full output is preserved in a temp file whose path is in the reply.
      expect(result.content[0].text).toMatch(/\[full output: .*pi-py-kernel-.*\]/);
    } finally {
      fx.cleanup();
    }
  });

  test("output truncation reports an object shape hint when the result is sized", async () => {
    const fx = tmpBase();
    try {
      const pi = fakePi();
      extension.default(pi as any);
      const tool = pi.tools[0];
      const result = await runViaExecute(tool, { code: "list(range(100_000))" });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("list len=100000");
      // The truncated repr carries the marker.
      expect(result.content[0].text).toContain("...[truncated");
    } finally {
      fx.cleanup();
    }
  });

  test("truncateOutput pure helper: head+marker+tail under the cap, passthrough under it", () => {
    const { text, truncated, originalLength } = extension.truncateOutput("a".repeat(100), 50);
    expect(truncated).toBe(true);
    expect(originalLength).toBe(100);
    expect(text).toContain("...[truncated 100 chars]...");
    expect(text.startsWith("a".repeat(8192) + "\n")).toBe(false); // head is 8192 then marker
    const small = extension.truncateOutput("hi", 50);
    expect(small.truncated).toBe(false);
    expect(small.text).toBe("hi");
  });

  test("stdlib prelude is pre-loaded into the kernel namespace", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {});
      const check = await kernel.runCell("json.dumps({'a': 1}) + '|' + re.sub('a', 'b', 'a') + '|' + str(Path('.') / 'x') + '|' + os.getcwd() + '|' + subprocess.run(['echo','hi'], capture_output=True, text=True).stdout.strip() + '|' + sys.version.split()[0]", false);
      expect(check.error).toBeNull();
      // repr() wraps the whole joined string in quotes; assert on the parts.
      expect(check.stdout).toContain('{"a": 1}');
      expect(check.stdout).toContain("|b|");
      expect(check.stdout).toContain("|x|");
      expect(check.stdout).toContain(fx.dir); // cwd is the fixture dir
      expect(check.stdout).toContain("|hi|"); // subprocess
      expect(check.stdout).toContain("|3."); // sys.version
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("prelude and audit list survive reset (xtrm-vs7f8 readme-check finding)", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {});
      // Prelude works before reset.
      const before = await kernel.runCell("subprocess.run(['echo','hi'], capture_output=True, text=True).stdout.strip()", false);
      expect(before.error).toBeNull();
      // Reset clears user state but must NOT clear the documented prelude.
      await kernel.runCell("x = 1", true, fx.dir);
      const after = await kernel.runCell("subprocess.run(['echo','hi'], capture_output=True, text=True).stdout.strip()", false);
      expect(after.error).toBeNull();
      expect(after.stdout.trim()).toBe("'hi'");
      // User state is still gone.
      const userState = await kernel.runCell("x", false);
      expect(userState.error?.ename).toBe("NameError");
      // _AUDIT still exists after reset (skills append to it).
      const audit = await kernel.runCell("_AUDIT.append({'op': 'write', 'path': '/tmp/x'}); len(_AUDIT)", false);
      expect(audit.error).toBeNull();
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("kernel binding: hasServiceRegistry detects canonical + legacy registries (xtrm-6z6.4)", () => {
    const fx = tmpBase();
    try {
      // No registry -> false.
      expect(extension.hasServiceRegistry(fx.dir)).toBe(false);
      // Canonical service-knowledge registry -> true.
      mkdirSync(join(fx.dir, ".xtrm", "skills", "infra", "service-knowledge"), { recursive: true });
      writeFileSync(join(fx.dir, ".xtrm", "skills", "infra", "service-knowledge", "service-registry.json"), "{}");
      expect(extension.hasServiceRegistry(fx.dir)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  test("kernel binding: registry absent -> service_knowledge NOT mounted (xtrm-6z6.4)", async () => {
    const fx = tmpBase();
    try {
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [], null);
      const call = await kernel.runCell("'service_knowledge' in dir()", false);
      expect(call.error).toBeNull();
      expect(call.stdout.trim()).toBe("False");
      // _sk_errors stays empty (no mount attempted).
      expect(call.sk_errors).toEqual([]);
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("kernel binding: registry present + package resolvable -> service_knowledge mounted (xtrm-6z6.4)", async () => {
    const fx = tmpBase();
    try {
      // Registry present in cwd.
      mkdirSync(join(fx.dir, ".xtrm", "skills", "infra", "service-knowledge"), { recursive: true });
      writeFileSync(join(fx.dir, ".xtrm", "skills", "infra", "service-knowledge", "service-registry.json"), "{}");
      // Resolve the installed package path the way the extension does.
      const skPath = await extension.resolveServiceKnowledgePath("python3");
      if (!skPath) {
        // Package not installed in this env -> binding gracefully absent; assert the
        // kernel still boots cleanly and records no error for a non-mount.
        const kernel = new PythonKernel(fx.dir, () => {}, {}, [], null);
        const call = await kernel.runCell("1 + 1", false);
        expect(call.error).toBeNull();
        kernel.kill();
        return;
      }
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [], skPath);
      const call = await kernel.runCell("service_knowledge.__version__", false);
      expect(call.error).toBeNull();
      expect(call.stdout).toMatch(/\d+\.\d+/); // version
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });

  test("kernel binding: sk_rebuild rides the audit seam (xtrm-6z6.4)", async () => {
    const fx = tmpBase();
    try {
      const skPath = await extension.resolveServiceKnowledgePath("python3");
      if (!skPath) {
        // Package absent: sk_rebuild must be a safe no-op (None), never a crash.
        const kernel = new PythonKernel(fx.dir, () => {}, {}, [], null);
        const call = await kernel.runCell("sk_rebuild()", false);
        expect(call.error).toBeNull();
        // The kernel execs cells with redirected stdout and does not echo
        // expression values (it is not a REPL), so a None return produces
        // no output. The contract is 'safe no-op': no error and no output.
        expect(call.stderr.trim()).toBe("");
        expect(call.stdout.trim()).toBe("");
        kernel.kill();
        return;
      }
      const kernel = new PythonKernel(fx.dir, () => {}, {}, [], skPath);
      const call = await kernel.runCell("sk_rebuild()", false);
      expect(call.error).toBeNull();
      // Either a real rebuild (with items) or an error dict — never a crash.
      expect(call.stdout).toMatch(/\{.*\}|None/);
      kernel.kill();
    } finally {
      fx.cleanup();
    }
  });
});
