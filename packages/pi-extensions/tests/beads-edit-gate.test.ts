import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CORE-2357: the edit gate in `extensions/beads` must honor Substrate claims
// where `bd` is dead (retired board, no database), and claim success notices
// must never fire for failed commands or garbage ids.
//
// Strategy: fake `bd`/`sb` binaries on PATH plus a fake home
// (XTRM_TEST_HOME), then drive the extensions through a fake `pi` object the
// same way `xtrm-agent-host/index.test.ts` does.

mock.module("@earendil-works/pi-coding-agent", () => ({
	isToolCallEventType: (toolName: string, event: any) => event?.toolName === toolName,
	isBashToolResult: (event: any) => event?.toolName === "bash",
}));

const beads = await import("../extensions/beads/index.ts");
const sessionFlow = await import("../extensions/session-flow/index.ts");

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
	};
	const fire = async (name: string, event: any, ctx: any) => {
		const out: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) out.push(await handler({ type: name, ...event }, ctx));
		return out;
	};
	return { pi, fire };
}

const ctxFor = (cwd: string, sessionId: string) => ({
	cwd,
	sessionId,
	sessionManager: { getSessionId: () => sessionId },
	hasUI: false,
});

const editCall = { toolName: "edit", input: { path: "/repo/file.ts" } };

// Fake `sb issue show <ref> --json`: claimed unless the ref is recorded released.
function makeBinDir(opts: { bdAlive: boolean; releasedRefs?: string[] }): string {
	const dir = mkdtempSync(join(tmpdir(), "gate-bin-"));
	const released = new Set(opts.releasedRefs ?? []);
	writeFileSync(
		join(dir, "bd"),
		opts.bdAlive
			? "#!/bin/sh\nif [ \"$1\" = \"kv\" ] && [ \"$2\" = \"get\" ]; then echo \"\"; exit 0; fi\necho '[]'; exit 0\n"
			: "#!/bin/sh\necho 'Error: no beads database found' >&2; exit 1\n",
	);
	const cases = [...released]
		.map((r) => `if [ "$ref" = "${r}" ]; then echo '{"ok":true,"data":{"claimState":"released","claim":{"holder":"pi","releasedAt":1}}}'; exit 0; fi`)
		.join("\n");
	writeFileSync(
		join(dir, "sb"),
		`#!/bin/sh\nref="$3"\n${cases}\necho '{"ok":true,"data":{"claimState":"claimed","claim":{"holder":"pi","releasedAt":null}}}'; exit 0\n`,
	);
	chmodSync(join(dir, "bd"), 0o755);
	chmodSync(join(dir, "sb"), 0o755);
	return dir;
}

let home: string;
let repo: string;
let binDirs: string[];
let oldPath: string;
let oldTestHome: string | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "gate-home-"));
	repo = mkdtempSync(join(tmpdir(), "gate-repo-"));
	mkdirSync(join(repo, ".beads")); // gate guard active, but no bd database inside
	binDirs = [];
	oldPath = process.env.PATH ?? "";
	oldTestHome = process.env.XTRM_TEST_HOME;
	process.env.XTRM_TEST_HOME = home;
});

afterEach(() => {
	process.env.PATH = oldPath;
	if (oldTestHome === undefined) delete process.env.XTRM_TEST_HOME;
	else process.env.XTRM_TEST_HOME = oldTestHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
	for (const dir of binDirs) rmSync(dir, { recursive: true, force: true });
});

function useBin(opts: { bdAlive: boolean; releasedRefs?: string[] }) {
	const dir = makeBinDir(opts);
	binDirs.push(dir);
	process.env.PATH = `${dir}:${oldPath}`;
}

describe("pure helpers", () => {
	test("isIssueRefToken rejects flags and placeholders", () => {
		expect(beads.isIssueRefToken("CORE-2357")).toBe(true);
		expect(beads.isIssueRefToken("bd-42")).toBe(true);
		expect(beads.isIssueRefToken("--claim")).toBe(false);
		expect(beads.isIssueRefToken("<id>")).toBe(false);
		expect(beads.isIssueRefToken(null)).toBe(false);
		expect(beads.isIssueRefToken("")).toBe(false);
	});

	test("parseSbClaimRef / parseSbUnclaimRef", () => {
		expect(beads.parseSbClaimRef("sb issue claim CORE-2357 --holder pi")).toBe("CORE-2357");
		expect(beads.parseSbClaimRef("sb issue claim --holder pi")).toBe(null);
		expect(beads.parseSbUnclaimRef("sb issue close CORE-2357 --reason x")).toBe("CORE-2357");
		expect(beads.parseSbUnclaimRef("sb issue release CORE-1 --holder pi")).toBe("CORE-1");
		expect(beads.parseSbUnclaimRef("sb issue show CORE-1 --json")).toBe(null);
	});

	test("marker round-trip is per (session, repo)", () => {
		beads.writeSbMarker("sess", repo, "CORE-9");
		expect(beads.readSbMarker("sess", repo)).toBe("CORE-9");
		expect(beads.readSbMarker("other", repo)).toBe(null);
		expect(beads.readSbMarker("sess", "/elsewhere")).toBe(null);
		beads.clearSbMarker("sess", repo, "WRONG");
		expect(beads.readSbMarker("sess", repo)).toBe("CORE-9");
		beads.clearSbMarker("sess", repo, "CORE-9");
		expect(beads.readSbMarker("sess", repo)).toBe(null);
	});

	test("session-flow exposes the same token guard", () => {
		expect(sessionFlow.isIssueRefToken("--claim")).toBe(false);
		expect(sessionFlow.isIssueRefToken("CORE-1")).toBe(true);
	});
});

describe("edit gate", () => {
	test("bd dead + sb-claimed marker allows the edit", async () => {
		useBin({ bdAlive: false });
		beads.writeSbMarker("s1", repo, "CORE-2357");
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		const out = await fire("tool_call", editCall, ctxFor(repo, "s1"));
		expect(out).toEqual([undefined]);
	});

	test("bd dead + no marker blocks, naming the sb path", async () => {
		useBin({ bdAlive: false });
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		const out = await fire("tool_call", editCall, ctxFor(repo, "s1"));
		expect((out[0] as any)?.block).toBe(true);
		expect((out[0] as any)?.reason).toContain("sb issue claim <ref>");
	});

	test("bd dead + released marker blocks and clears the marker", async () => {
		useBin({ bdAlive: false, releasedRefs: ["CORE-OLD"] });
		beads.writeSbMarker("s1", repo, "CORE-OLD");
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		const out = await fire("tool_call", editCall, ctxFor(repo, "s1"));
		expect((out[0] as any)?.block).toBe(true);
		expect(beads.readSbMarker("s1", repo)).toBe(null);
	});

	test("bd alive keeps legacy behaviour: no marker, no sb hint", async () => {
		useBin({ bdAlive: true });
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		const out = await fire("tool_call", editCall, ctxFor(repo, "s1"));
		expect((out[0] as any)?.block).toBe(true);
		expect((out[0] as any)?.reason).not.toContain("sb issue claim");
	});
});

describe("claim notices", () => {
	const bashResult = (command: string, isError: boolean) => ({
		toolName: "bash",
		input: { command },
		isError,
		content: [{ type: "text", text: "out" }],
	});

	test("successful sb claim writes the marker and appends a notice", async () => {
		useBin({ bdAlive: false });
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		const ctx = ctxFor(repo, "s1");
		const out = await fire("tool_result", bashResult("sb issue claim CORE-2357 --holder pi", false), ctx);
		expect(beads.readSbMarker("s1", repo)).toBe("CORE-2357");
		expect(JSON.stringify(out[0])).toContain("Substrate");
		expect(await fire("tool_call", editCall, ctx)).toEqual([undefined]);
	});

	test("failed sb claim writes nothing and stays silent", async () => {
		useBin({ bdAlive: false });
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		const out = await fire("tool_result", bashResult("sb issue claim CORE-2357 --holder pi", true), ctxFor(repo, "s1"));
		expect(beads.readSbMarker("s1", repo)).toBe(null);
		expect(out).toEqual([undefined]);
	});

	test("successful sb close clears the marker", async () => {
		useBin({ bdAlive: false });
		beads.writeSbMarker("s1", repo, "CORE-2357");
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		await fire("tool_result", bashResult("sb issue close CORE-2357 --reason done", false), ctxFor(repo, "s1"));
		expect(beads.readSbMarker("s1", repo)).toBe(null);
	});

	test("failed bd claim appends no notice", async () => {
		useBin({ bdAlive: false });
		const { pi, fire } = fakePi();
		beads.default(pi as any);
		const out = await fire("tool_result", bashResult("bd update CORE-9 --claim", true), ctxFor(repo, "s1"));
		expect(out).toEqual([undefined]);
	});

	test("garbage ids never produce notices (beads + session-flow)", async () => {
		useBin({ bdAlive: false });
		const { pi: piA, fire: fireA } = fakePi();
		beads.default(piA as any);
		const { pi: piB, fire: fireB } = fakePi();
		sessionFlow.default(piB as any);
		const ctx = ctxFor(repo, "s1");
		const garbage = "python3 - <<'EOF'\n# bd update --claim must never print\nEOF";
		expect(await fireA("tool_result", bashResult(garbage, false), ctx)).toEqual([undefined]);
		expect(await fireB("tool_result", bashResult(garbage, false), ctx)).toEqual([undefined]);
		expect(await fireB("tool_result", bashResult("bd update CORE-9 --claim", true), ctx)).toEqual([undefined]);
	});
});
