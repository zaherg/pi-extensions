import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	FAILURES,
	filterPosthook,
	invokeRtk,
	preservesBoundaries,
} from "../bridge.ts";
import {
	classifyBash,
	formatReport,
	parseCoverageArgs,
	type Scan,
	scanSessions,
	sessionFiles,
	type Usage,
	windowStart,
} from "../coverage.ts";
import {
	ENTRY_TYPE,
	Ledger,
	mergeTallies,
	parseEntry,
	type Sample,
	type Tally,
} from "../outcomes.ts";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function createFakeRtk(dir: string, scriptBody: string): Promise<string> {
	const implPath = join(dir, "fake-rtk.mjs");
	const binPath = join(dir, "rtk");
	await writeFile(implPath, scriptBody, "utf8");
	const wrapper = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(implPath)} "$@"\n`;
	await writeFile(binPath, wrapper, "utf8");
	await chmod(binPath, 0o755);
	return binPath;
}

after(async () => {
	await Promise.all(
		tempRoots.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("bridge.ts — preservesBoundaries", () => {
	it("accepts valid multi-file FFF output when numbered lines are elided", () => {
		const original = [
			"src/alpha.ts",
			" 10: const a = 1;",
			" 11- const b = 2;",
			" 12: const c = 3;",
			"",
			"src/beta.ts",
			" 20: export function run() {}",
			" 21- // context",
			"[2 matches in 2 files]",
		].join("\n");

		const filtered = [
			"src/alpha.ts",
			" 10: const a = 1;",
			"[... 2 lines elided ...]",
			"src/beta.ts",
			" 20: export function run() {}",
			"[2 matches in 2 files]",
		].join("\n");

		assert.equal(preservesBoundaries(original, filtered), true);
	});

	it("rejects filtered output that drops a file heading", () => {
		const original = [
			"src/alpha.ts",
			" 1: first",
			"",
			"src/beta.ts",
			" 2: second",
		].join("\n");

		const filtered = ["src/alpha.ts", " 1: first", " 2: second"].join("\n");

		assert.equal(preservesBoundaries(original, filtered), false);
	});

	it("rejects filtered output that reorders file headings", () => {
		const original = [
			"src/alpha.ts",
			" 1: first",
			"",
			"src/beta.ts",
			" 2: second",
		].join("\n");

		const filtered = [
			"src/beta.ts",
			" 2: second",
			"",
			"src/alpha.ts",
			" 1: first",
		].join("\n");

		assert.equal(preservesBoundaries(original, filtered), false);
	});

	it("rejects numbered lines that appear without a preceding file heading", () => {
		const atStart = [" 10: orphan match", " 11: second"].join("\n");
		assert.equal(preservesBoundaries(atStart, atStart), false);

		const afterBlank = [
			"src/alpha.ts",
			" 1: ok",
			"",
			" 2: orphan after blank",
		].join("\n");
		assert.equal(preservesBoundaries(afterBlank, afterBlank), false);
	});

	it("handles [0 exact matches. Maybe you meant this?] heading expectation", () => {
		const validFuzzy = [
			"[0 exact matches. Maybe you meant this?]",
			"src/fuzzy.ts",
			" 4: nearMatch()",
		].join("\n");
		assert.equal(preservesBoundaries(validFuzzy, validFuzzy), true);

		const droppedNotice = ["src/fuzzy.ts", " 4: nearMatch()"].join("\n");
		assert.equal(preservesBoundaries(validFuzzy, droppedNotice), false);

		const numberedRightAfterNotice = [
			"[0 exact matches. Maybe you meant this?]",
			" 4: noHeadingAfterNotice()",
		].join("\n");
		assert.equal(
			preservesBoundaries(numberedRightAfterNotice, numberedRightAfterNotice),
			false,
		);
	});

	it("treats blank and whitespace-only lines as section separators without requiring them in filtered output", () => {
		const original = [
			"",
			"   ",
			"src/one.ts",
			" 1: a",
			"",
			"   ",
			"src/two.ts",
			" 2: b",
			"",
		].join("\n");
		const filtered = ["src/one.ts", "src/two.ts"].join("\n");
		assert.equal(preservesBoundaries(original, filtered), true);
	});
});

describe("bridge.ts — invokeRtk", () => {
	it("passes args, stdin, cwd, and RTK_CONFIG_DIR on the happy path", async () => {
		const dir = await makeTempDir("rtk-invoke-ok-");
		const cfgDir = join(dir, "cfg");
		await mkdir(cfgDir);
		const bin = await createFakeRtk(
			dir,
			`
import { readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({
	args: process.argv.slice(2),
	stdin,
	cwd: process.cwd(),
	rtkConfigDir: process.env.RTK_CONFIG_DIR,
	customEnv: process.env.CUSTOM_FLAG,
}));
`,
		);

		const res = await invokeRtk(["hook", "claude"], "hello stdin", {
			configDirectory: cfgDir,
			executable: bin,
			env: {
				...process.env,
				CUSTOM_FLAG: "yes",
				RTK_CONFIG_DIR: "/should-be-overridden",
			},
		});

		assert.equal(res.ok, true);
		if (!res.ok) return;
		const parsed = JSON.parse(res.stdout) as {
			args: string[];
			stdin: string;
			cwd: string;
			rtkConfigDir: string;
			customEnv: string;
		};
		assert.deepEqual(parsed.args, ["hook", "claude"]);
		assert.equal(parsed.stdin, "hello stdin");
		assert.equal(parsed.rtkConfigDir, cfgDir);
		assert.equal(parsed.customEnv, "yes");
		assert.ok(parsed.cwd.endsWith("cfg"));
	});

	it("returns unavailable when executable does not exist", async () => {
		const dir = await makeTempDir("rtk-invoke-missing-");
		const res = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: dir,
			executable: join(dir, "does-not-exist-rtk"),
		});
		assert.deepEqual(res, { ok: false, reason: "unavailable" });
	});

	it("returns process when subprocess exits non-zero", async () => {
		const dir = await makeTempDir("rtk-invoke-nonzero-");
		const bin = await createFakeRtk(
			dir,
			`process.stderr.write("boom\\n"); process.exit(2);`,
		);
		const res = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: dir,
			executable: bin,
		});
		assert.deepEqual(res, { ok: false, reason: "process" });
	});

	it("succeeds when child exits 0 early without draining >64 KiB stdin pipe", async () => {
		const dir = await makeTempDir("rtk-invoke-epipe-");
		const bin = await createFakeRtk(
			dir,
			`process.stdout.write(""); process.exit(0);`,
		);
		const largeInput = "x".repeat(256 * 1024);
		const res = await invokeRtk(["hook", "claude"], largeInput, {
			configDirectory: dir,
			executable: bin,
		});
		assert.deepEqual(res, { ok: true, stdout: "" });
	});

	it("returns timeout when subprocess exceeds timeoutMs", async () => {
		const dir = await makeTempDir("rtk-invoke-timeout-");
		const bin = await createFakeRtk(
			dir,
			`setTimeout(() => process.stdout.write("late"), 5_000);`,
		);
		const res = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: dir,
			executable: bin,
			timeoutMs: 80,
		});
		assert.deepEqual(res, { ok: false, reason: "timeout" });
	});

	it("returns timeout promptly even when a detached grandchild inherits stdout/stderr pipes", async () => {
		const dir = await makeTempDir("rtk-invoke-grandchild-");
		const pidFile = join(dir, "grandchild.pid");
		const bin = await createFakeRtk(
			dir,
			`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grand = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
	detached: true,
	stdio: "inherit",
});
if (grand.pid) writeFileSync(${JSON.stringify(pidFile)}, String(grand.pid), "utf8");
grand.unref();
setTimeout(() => {}, 10_000);
`,
		);
		const start = performance.now();
		try {
			const res = await invokeRtk(["hook", "claude"], "hi", {
				configDirectory: dir,
				executable: bin,
				timeoutMs: 120,
			});
			const elapsed = performance.now() - start;
			assert.deepEqual(res, { ok: false, reason: "timeout" });
			assert.ok(elapsed < 2_500, `expected prompt timeout, took ${elapsed}ms`);
		} finally {
			const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
			if (pid > 0) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already exited.
				}
			}
		}
	});

	it("returns aborted when signal is already aborted or aborts mid-flight", async () => {
		const dir = await makeTempDir("rtk-invoke-abort-");
		const bin = await createFakeRtk(
			dir,
			`setTimeout(() => process.stdout.write("late"), 5_000);`,
		);

		const preAborted = new AbortController();
		preAborted.abort();
		const res1 = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: dir,
			executable: bin,
			signal: preAborted.signal,
		});
		assert.deepEqual(res1, { ok: false, reason: "aborted" });

		const mid = new AbortController();
		setTimeout(() => mid.abort(), 50);
		const res2 = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: dir,
			executable: bin,
			signal: mid.signal,
			timeoutMs: 5_000,
		});
		assert.deepEqual(res2, { ok: false, reason: "aborted" });
	});

	it("returns input-limit based on UTF-8 byte length", async () => {
		const dir = await makeTempDir("rtk-invoke-inlimit-");
		const bin = await createFakeRtk(dir, `process.stdout.write("ok");`);
		// Each rocket emoji is 4 UTF-8 bytes (2 UTF-16 code units). 10 emojis = 40 bytes > 32.
		const res = await invokeRtk(["hook", "claude"], "🚀".repeat(10), {
			configDirectory: dir,
			executable: bin,
			maxBytes: 32,
		});
		assert.deepEqual(res, { ok: false, reason: "input-limit" });
	});

	it("returns output-limit when stdout or combined stdout+stderr exceeds maxBytes", async () => {
		const dir = await makeTempDir("rtk-invoke-outlimit-");
		const stdoutBin = await createFakeRtk(
			dir,
			`process.stdout.write("x".repeat(200));`,
		);
		const res1 = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: dir,
			executable: stdoutBin,
			maxBytes: 100,
		});
		assert.deepEqual(res1, { ok: false, reason: "output-limit" });

		const stderrDir = await makeTempDir("rtk-invoke-stderrlimit-");
		const stderrBin = await createFakeRtk(
			stderrDir,
			`process.stdout.write("a".repeat(60)); process.stderr.write("b".repeat(60));`,
		);
		const res2 = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: stderrDir,
			executable: stderrBin,
			maxBytes: 100,
		});
		assert.deepEqual(res2, { ok: false, reason: "output-limit" });
	});

	it("returns protocol when stdout contains invalid UTF-8 bytes", async () => {
		const dir = await makeTempDir("rtk-invoke-badutf8-");
		const bin = await createFakeRtk(
			dir,
			`process.stdout.write(Buffer.from([0xff, 0xfe, 0x80]));`,
		);
		const res = await invokeRtk(["hook", "claude"], "hi", {
			configDirectory: dir,
			executable: bin,
		});
		assert.deepEqual(res, { ok: false, reason: "protocol" });
	});
});

describe("bridge.ts — filterPosthook", () => {
	const alwaysOk = () => true;
	const sampleHash = "0123456789abcdef";

	function makeEnvelope(text: string): string {
		return JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				updatedToolOutput: {
					content: [{ type: "text", text }],
				},
			},
		});
	}

	it("filters output, omits tool_input, and verifies exact recall readback", async () => {
		const dir = await makeTempDir("rtk-posthook-happy-");
		const logFile = join(dir, "calls.jsonl");
		const storeFile = join(dir, "recall.txt");
		const bin = await createFakeRtk(
			dir,
			`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, stdin }) + "\\n");
if (args[0] === "hook" && args[1] === "claude") {
	const payload = JSON.parse(stdin);
	const original = payload.tool_response.content[0].text;
	writeFileSync(${JSON.stringify(storeFile)}, original, "utf8");
	const filtered = "short summary\\n[full output: rtk recall ${sampleHash}]";
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PostToolUse",
			updatedToolOutput: { content: [{ type: "text", text: filtered }] },
		},
	}));
} else if (args[0] === "recall" && args[1] === "${sampleHash}" && args[2] === "--full") {
	process.stdout.write(readFileSync(${JSON.stringify(storeFile)}, "utf8"));
} else {
	process.exit(1);
}
`,
		);

		const original = "line of noisy output\n".repeat(30);
		const result = await filterPosthook(
			"pi-bash",
			original,
			{ configDirectory: dir, executable: bin },
			alwaysOk,
			true,
		);

		assert.deepEqual(result, {
			kind: "filtered",
			text: `short summary\n[full output: rtk recall ${sampleHash}]`,
		});

		const calls = (await readFile(logFile, "utf8"))
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { args: string[]; stdin: string });
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0]?.args, ["hook", "claude"]);
		const payload = JSON.parse(calls[0]?.stdin ?? "{}") as {
			hook_event_name: string;
			tool_name: string;
			tool_input: Record<string, unknown>;
			tool_response: { content: Array<{ type: string; text: string }> };
		};
		assert.equal(payload.hook_event_name, "PostToolUse");
		assert.equal(payload.tool_name, "pi-bash");
		assert.deepEqual(payload.tool_input, {});
		assert.equal(payload.tool_response.content[0]?.text, original);
		assert.deepEqual(calls[1]?.args, ["recall", sampleHash, "--full"]);
	});

	it("returns recovery when recall output mismatches or recall hint is missing", async () => {
		const dir = await makeTempDir("rtk-posthook-recall-mismatch-");
		const binMismatch = await createFakeRtk(
			dir,
			`
const args = process.argv.slice(2);
if (args[0] === "hook") {
	process.stdout.write(${JSON.stringify(makeEnvelope(`short\n[full output: rtk recall ${sampleHash}]`))});
} else {
	process.stdout.write("corrupted original text");
}
`,
		);
		const original = "original payload text ".repeat(20);
		const res1 = await filterPosthook(
			"pi-bash",
			original,
			{ configDirectory: dir, executable: binMismatch },
			alwaysOk,
			true,
		);
		assert.deepEqual(res1, { kind: "failed", reason: "recovery" });

		const dirNoHint = await makeTempDir("rtk-posthook-nohint-");
		const binNoHint = await createFakeRtk(
			dirNoHint,
			`process.stdout.write(${JSON.stringify(makeEnvelope("short without recall hint"))});`,
		);
		const res2 = await filterPosthook(
			"pi-bash",
			original,
			{ configDirectory: dirNoHint, executable: binNoHint },
			alwaysOk,
			false,
		);
		assert.deepEqual(res2, { kind: "failed", reason: "recovery" });
	});

	it("propagates subprocess failure from recall readback", async () => {
		const dir = await makeTempDir("rtk-posthook-recall-fail-");
		const bin = await createFakeRtk(
			dir,
			`
if (process.argv[2] === "hook") {
	process.stdout.write(${JSON.stringify(makeEnvelope(`short\n[full output: rtk recall ${sampleHash}]`))});
} else {
	process.exit(1);
}
`,
		);
		const res = await filterPosthook(
			"pi-bash",
			"original payload text ".repeat(20),
			{ configDirectory: dir, executable: bin },
			alwaysOk,
			true,
		);
		assert.deepEqual(res, { kind: "failed", reason: "process" });
	});

	it("returns boundaries when structure check fails and does not call recall", async () => {
		const dir = await makeTempDir("rtk-posthook-boundaries-");
		const recallMarker = join(dir, "recall-called");
		const bin = await createFakeRtk(
			dir,
			`
import { writeFileSync } from "node:fs";
if (process.argv[2] === "hook") {
	process.stdout.write(${JSON.stringify(makeEnvelope(`src/a.ts\n 1: match\n[full output: rtk recall ${sampleHash}]`))});
} else {
	writeFileSync(${JSON.stringify(recallMarker)}, "called");
}
`,
		);
		const original = [
			"src/a.ts",
			" 1: match",
			"",
			"src/b.ts",
			" 2: dropped heading",
			" 3: extra padding line ".repeat(10),
		].join("\n");

		const res = await filterPosthook(
			"pi-ffgrep",
			original,
			{ configDirectory: dir, executable: bin },
			preservesBoundaries,
			true,
		);
		assert.deepEqual(res, { kind: "failed", reason: "boundaries" });
		await assert.rejects(readFile(recallMarker, "utf8"));
	});

	it("propagates unavailable, process, timeout, aborted, input-limit, output-limit, and invalid UTF-8 failures", async () => {
		const dir = await makeTempDir("rtk-posthook-failures-");
		const original = "payload ".repeat(40);

		const unavail = await filterPosthook(
			"pi-bash",
			original,
			{ configDirectory: dir, executable: join(dir, "missing") },
			alwaysOk,
		);
		assert.deepEqual(unavail, { kind: "failed", reason: "unavailable" });

		const exitBin = await createFakeRtk(
			await makeTempDir("rtk-pf-exit-"),
			`process.exit(3);`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: dir, executable: exitBin },
				alwaysOk,
			),
			{ kind: "failed", reason: "process" },
		);

		const slowBin = await createFakeRtk(
			await makeTempDir("rtk-pf-slow-"),
			`setTimeout(() => {}, 5_000);`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: dir, executable: slowBin, timeoutMs: 80 },
				alwaysOk,
			),
			{ kind: "failed", reason: "timeout" },
		);

		const ac = new AbortController();
		ac.abort();
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: dir, executable: slowBin, signal: ac.signal },
				alwaysOk,
			),
			{ kind: "failed", reason: "aborted" },
		);

		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: dir, executable: exitBin, maxBytes: 32 },
				alwaysOk,
			),
			{ kind: "failed", reason: "input-limit" },
		);

		const bigOutBin = await createFakeRtk(
			await makeTempDir("rtk-pf-bigout-"),
			`process.stdout.write("z".repeat(400));`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				"x".repeat(50),
				{ configDirectory: dir, executable: bigOutBin, maxBytes: 300 },
				alwaysOk,
			),
			{ kind: "failed", reason: "output-limit" },
		);

		const badUtf8Bin = await createFakeRtk(
			await makeTempDir("rtk-pf-utf8-"),
			`process.stdout.write(Buffer.from([0xc3, 0x28]));`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: dir, executable: badUtf8Bin },
				alwaysOk,
			),
			{ kind: "failed", reason: "protocol" },
		);
	});

	it("returns protocol on invalid JSON or malformed hook envelopes", async () => {
		const original = "payload ".repeat(40);
		const invalidPayloads = [
			"not json at all",
			JSON.stringify({}),
			JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse" } }),
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedToolOutput: { content: [] },
				},
			}),
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedToolOutput: {
						content: [
							{ type: "text", text: "a" },
							{ type: "text", text: "b" },
						],
					},
				},
			}),
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedToolOutput: { content: [{ type: "image", data: "abc" }] },
				},
			}),
			makeEnvelope(""),
		];

		for (const stdout of invalidPayloads) {
			const dir = await makeTempDir("rtk-pf-proto-");
			const bin = await createFakeRtk(
				dir,
				`process.stdout.write(${JSON.stringify(stdout)});`,
			);
			const res = await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: dir, executable: bin },
				alwaysOk,
			);
			assert.deepEqual(res, { kind: "failed", reason: "protocol" });
		}
	});

	it("returns unchanged for empty stdout, identical text, or non-shrinking UTF-8 output", async () => {
		const original = "hello world 1234567890";

		const emptyDir = await makeTempDir("rtk-pf-empty-");
		const emptyBin = await createFakeRtk(
			emptyDir,
			`process.stdout.write("   \\n\\t  ");`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: emptyDir, executable: emptyBin },
				alwaysOk,
			),
			{ kind: "unchanged" },
		);

		const sameDir = await makeTempDir("rtk-pf-same-");
		const sameBin = await createFakeRtk(
			sameDir,
			`process.stdout.write(${JSON.stringify(makeEnvelope(original))});`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: sameDir, executable: sameBin },
				alwaysOk,
			),
			{ kind: "unchanged" },
		);

		// Multi-byte UTF-8 replacement that has fewer characters than original but >= bytes.
		const largerBytes = "🚀".repeat(6); // 6 chars (12 UTF-16) = 24 bytes > 22 bytes
		assert.ok(Buffer.byteLength(largerBytes) >= Buffer.byteLength(original));
		const growDir = await makeTempDir("rtk-pf-grow-");
		const growBin = await createFakeRtk(
			growDir,
			`process.stdout.write(${JSON.stringify(makeEnvelope(largerBytes))});`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: growDir, executable: growBin },
				alwaysOk,
			),
			{ kind: "unchanged" },
		);
	});

	it("skips recall readback when verifyRecall is false unless original contains recall hint or hash (even obfuscated)", async () => {
		const dir = await makeTempDir("rtk-pf-skiprecall-");
		const recallCountFile = join(dir, "recall-count.txt");
		const storeFile = join(dir, "store.txt");
		const bin = await createFakeRtk(
			dir,
			`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "hook") {
	const payload = JSON.parse(readFileSync(0, "utf8"));
	writeFileSync(${JSON.stringify(storeFile)}, payload.tool_response.content[0].text, "utf8");
	process.stdout.write(${JSON.stringify(makeEnvelope(`ok\n[full output: rtk recall ${sampleHash}]`))});
} else if (args[0] === "recall") {
	const prev = existsSync(${JSON.stringify(recallCountFile)}) ? Number(readFileSync(${JSON.stringify(recallCountFile)}, "utf8")) : 0;
	writeFileSync(${JSON.stringify(recallCountFile)}, String(prev + 1), "utf8");
	process.stdout.write(readFileSync(${JSON.stringify(storeFile)}, "utf8"));
}
`,
		);

		// 1. Plain original without hash/hint -> skips recall when verifyRecall = false
		const plain = "normal log line without hash\n".repeat(20);
		const r1 = await filterPosthook(
			"pi-bash",
			plain,
			{ configDirectory: dir, executable: bin },
			alwaysOk,
			false,
		);
		assert.equal(r1.kind, "filtered");
		await assert.rejects(readFile(recallCountFile, "utf8"));

		// 2. Original already ends with a recall hint -> forces recall even with verifyRecall = false
		const withHint = `${plain}\n[full output: rtk recall fedcba9876543210]`;
		const r2 = await filterPosthook(
			"pi-bash",
			withHint,
			{ configDirectory: dir, executable: bin },
			alwaysOk,
			false,
		);
		assert.equal(r2.kind, "filtered");
		assert.equal(await readFile(recallCountFile, "utf8"), "1");

		// 3. Original embeds the literal hash -> forces recall
		const withHash = `${plain} contains ${sampleHash} inside`;
		const r3 = await filterPosthook(
			"pi-bash",
			withHash,
			{ configDirectory: dir, executable: bin },
			alwaysOk,
			false,
		);
		assert.equal(r3.kind, "filtered");
		assert.equal(await readFile(recallCountFile, "utf8"), "2");

		// 4. Original obfuscates the hash with ANSI escape + zero-width format chars -> forces recall
		const obfuscated = `${plain} \u001b[31m01234567\u001b[0m\u200b89abcdef`;
		const r4 = await filterPosthook(
			"pi-bash",
			obfuscated,
			{ configDirectory: dir, executable: bin },
			alwaysOk,
			false,
		);
		assert.equal(r4.kind, "filtered");
		assert.equal(await readFile(recallCountFile, "utf8"), "3");
	});
});

describe("outcomes.ts — Ledger, mergeTallies & parseEntry", () => {
	it("returns undefined when draining an empty ledger and clears after drain/clear", () => {
		const ledger = new Ledger();
		assert.equal(ledger.drain(), undefined);

		ledger.record({
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "filtered",
			bytesBefore: 1000,
			bytesAfter: 400,
		});
		ledger.clear();
		assert.equal(ledger.drain(), undefined);

		const sample: Sample = {
			tool: "read",
			category: "read",
			mechanism: "read-dedup",
			outcome: "filtered",
			bytesBefore: 2000,
			bytesAfter: 250,
		};
		ledger.record(sample);
		// Mutating original sample must not mutate ledger entry
		sample.bytesBefore = 999999;

		const drained = ledger.drain();
		assert.ok(drained);
		assert.equal(drained.version, 1);
		assert.equal(drained.tallies.length, 1);
		assert.deepEqual(drained.tallies[0], {
			tool: "read",
			category: "read",
			mechanism: "read-dedup",
			outcome: "filtered",
			count: 1,
			bytesBefore: 2000,
			bytesAfter: 250,
		});
		assert.equal(ledger.drain(), undefined);
	});

	it("aggregates matching tuples and keeps distinct tool/category/mechanism/outcome/reason separate", () => {
		const ledger = new Ledger();
		const samples: Sample[] = [
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "filtered",
				bytesBefore: 1000,
				bytesAfter: 300,
			},
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "filtered",
				bytesBefore: 2000,
				bytesAfter: 500,
			},
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "unchanged",
				bytesBefore: 800,
				bytesAfter: 800,
			},
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "failed",
				reason: "timeout",
				bytesBefore: 900,
				bytesAfter: 900,
			},
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "failed",
				reason: "timeout",
				bytesBefore: 1100,
				bytesAfter: 1100,
			},
			{
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "failed",
				reason: "process",
				bytesBefore: 700,
				bytesAfter: 700,
			},
			{
				tool: "grep",
				category: "listing",
				mechanism: "rtk:listing+grep-group",
				outcome: "filtered",
				bytesBefore: 3000,
				bytesAfter: 1200,
			},
		];
		for (const s of samples) ledger.record(s);

		const data = ledger.drain();
		assert.ok(data);
		assert.equal(data.tallies.length, 5);
		assert.deepEqual(parseEntry(data), data);

		const byKey = new Map(
			data.tallies.map((t) => [
				`${t.tool}|${t.category}|${t.mechanism}|${t.outcome}|${t.reason ?? ""}`,
				t,
			]),
		);
		assert.deepEqual(byKey.get("bash|terminal|rtk:terminal|filtered|"), {
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "filtered",
			count: 2,
			bytesBefore: 3000,
			bytesAfter: 800,
		});
		assert.deepEqual(byKey.get("bash|terminal|rtk:terminal|failed|timeout"), {
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "failed",
			reason: "timeout",
			count: 2,
			bytesBefore: 2000,
			bytesAfter: 2000,
		});
		assert.equal(
			byKey.get("bash|terminal|rtk:terminal|failed|process")?.count,
			1,
		);
		assert.equal(
			byKey.get("grep|listing|rtk:listing+grep-group|filtered|")?.count,
			1,
		);
	});

	it("mergeTallies combines counts and byte totals without mutating inputs", () => {
		const map = new Map<string, Tally>();
		const first: Tally = {
			tool: "mcp-search",
			category: "generic",
			mechanism: "excerpt-dedup+suffix-factor",
			outcome: "filtered",
			count: 2,
			bytesBefore: 5000,
			bytesAfter: 2000,
		};
		const second: Tally = {
			...first,
			count: 3,
			bytesBefore: 7000,
			bytesAfter: 2500,
		};
		mergeTallies(map, first);
		mergeTallies(map, second);
		assert.equal(first.count, 2);
		const [merged] = [...map.values()];
		assert.deepEqual(merged, {
			tool: "mcp-search",
			category: "generic",
			mechanism: "excerpt-dedup+suffix-factor",
			outcome: "filtered",
			count: 5,
			bytesBefore: 12000,
			bytesAfter: 4500,
		});
	});

	it("parseEntry validates schema invariants strictly", () => {
		const validAllFailures = {
			version: 1,
			tallies: FAILURES.map((reason) => ({
				tool: "bash",
				category: "terminal",
				mechanism: "rtk:terminal",
				outcome: "failed",
				reason,
				count: 1,
				bytesBefore: 600,
				bytesAfter: 600,
			})),
		};
		assert.deepEqual(parseEntry(validAllFailures), validAllFailures);

		const baseValid: Tally = {
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "filtered",
			count: 1,
			bytesBefore: 1000,
			bytesAfter: 500,
		};
		const invalidCases: unknown[] = [
			null,
			[],
			"string",
			{ version: 2, tallies: [baseValid] },
			{ version: 1, tallies: [baseValid], extra: true },
			{ version: 1, tallies: [] },
			{ version: 1, tallies: "nope" },
			{ version: 1, tallies: [{ ...baseValid, extraField: 1 }] },
			{ version: 1, tallies: [{ ...baseValid, tool: "" }] },
			{ version: 1, tallies: [{ ...baseValid, category: "unknown" }] },
			{ version: 1, tallies: [{ ...baseValid, outcome: "skipped" }] },
			{ version: 1, tallies: [{ ...baseValid, mechanism: "BadCase" }] },
			{ version: 1, tallies: [{ ...baseValid, mechanism: "+leading" }] },
			{ version: 1, tallies: [{ ...baseValid, count: 0 }] },
			{ version: 1, tallies: [{ ...baseValid, count: 1.5 }] },
			{ version: 1, tallies: [{ ...baseValid, bytesAfter: 1000 }] }, // filtered must shrink
			{ version: 1, tallies: [{ ...baseValid, bytesAfter: 1200 }] },
			{
				version: 1,
				tallies: [
					{
						...baseValid,
						outcome: "unchanged",
						bytesBefore: 1000,
						bytesAfter: 900,
					},
				],
			},
			{
				version: 1,
				tallies: [
					{
						...baseValid,
						outcome: "filtered",
						reason: "timeout",
					},
				],
			},
			{
				version: 1,
				tallies: [
					{
						...baseValid,
						outcome: "failed",
						bytesAfter: 1000,
					},
				],
			},
			{
				version: 1,
				tallies: [
					{
						...baseValid,
						outcome: "failed",
						reason: "not-a-failure",
						bytesAfter: 1000,
					},
				],
			},
		];

		for (const candidate of invalidCases) {
			assert.equal(parseEntry(candidate), undefined);
		}
	});
});

describe("coverage.ts — parseCoverageArgs", () => {
	it("parses defaults, days, scope, and both argument orders", () => {
		assert.deepEqual(parseCoverageArgs(""), {
			ok: true,
			options: { days: 30, scope: "project" },
		});
		assert.deepEqual(parseCoverageArgs("   \t  "), {
			ok: true,
			options: { days: 30, scope: "project" },
		});
		assert.deepEqual(parseCoverageArgs("1"), {
			ok: true,
			options: { days: 1, scope: "project" },
		});
		assert.deepEqual(parseCoverageArgs("365 all"), {
			ok: true,
			options: { days: 365, scope: "all" },
		});
		assert.deepEqual(parseCoverageArgs("all 14"), {
			ok: true,
			options: { days: 14, scope: "all" },
		});
		assert.deepEqual(parseCoverageArgs("project 7"), {
			ok: true,
			options: { days: 7, scope: "project" },
		});
	});

	it("rejects out-of-range days, unknown arguments, and duplicate flags", () => {
		for (const bad of [
			"0",
			"366",
			"999",
			"1000",
			"-5",
			"foo",
			"7 14",
			"all project",
			"all all",
		]) {
			const res = parseCoverageArgs(bad);
			assert.equal(res.ok, false, `expected "${bad}" to fail`);
		}
	});
});

describe("coverage.ts — sessionFiles & scanSessions", () => {
	it("discovers recent session jsonl files respecting scope, mtime, depth, ignored dirs, symlinks, and empty sessionDir", async () => {
		const root = await makeTempDir("rtk-sessions-");
		const projA = join(root, "proj-a");
		const projB = join(root, "proj-b");
		const nested4 = join(projA, "s1", "r1", "r2", "r3");
		const nested5 = join(nested4, "too-deep");
		const ignored = join(projA, "subagent-artifacts");
		await mkdir(nested5, { recursive: true });
		await mkdir(ignored, { recursive: true });
		await mkdir(projB, { recursive: true });

		const recentA = join(projA, "recent.jsonl");
		const oldA = join(projA, "old.jsonl");
		const nonJsonl = join(projA, "notes.txt");
		const depth4File = join(nested4, "subagent.jsonl");
		const depth5File = join(nested5, "ignored-deep.jsonl");
		const artifactFile = join(ignored, "dup.jsonl");
		const recentB = join(projB, "other-proj.jsonl");

		for (const f of [
			recentA,
			oldA,
			nonJsonl,
			depth4File,
			depth5File,
			artifactFile,
			recentB,
		]) {
			await writeFile(f, "{}\n", "utf8");
		}
		await symlink(recentB, join(projA, "linked.jsonl"));
		await symlink(projB, join(projA, "linked-dir"));

		const nowMs = Date.now();
		const oldSec = (nowMs - 10 * 86_400_000) / 1000;
		await utimes(oldA, oldSec, oldSec);

		const sinceMs = nowMs - 2 * 86_400_000;
		const projectOnly = await sessionFiles(projA, "project", sinceMs);
		assert.deepEqual(projectOnly, [recentA, depth4File].sort());

		const allProjects = await sessionFiles(projA, "all", sinceMs);
		assert.deepEqual(allProjects, [recentA, depth4File, recentB].sort());

		// Missing or empty (--no-session) directory returns empty list rather than scanning cwd
		assert.deepEqual(
			await sessionFiles(join(root, "nonexistent"), "project", sinceMs),
			[],
		);
		assert.deepEqual(await sessionFiles("", "all", sinceMs), []);
		assert.deepEqual(await sessionFiles("   ", "project", sinceMs), []);
	});

	it("scans JSONL sessions for tool bytes, bash command pairing, outcomes, windowing, malformed lines, and vanished files", async () => {
		const dir = await makeTempDir("rtk-scan-");
		const file1 = join(dir, "s1.jsonl");
		const file2 = join(dir, "s2.jsonl");
		const vanished = join(dir, "vanished.jsonl");
		const now = 1_700_000_000_000;
		const since = now - 86_400_000;
		const oldTime = since - 10_000;

		const file1Lines = [
			// Assistant bash tool calls
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-git",
							name: "bash",
							arguments: { command: "git status" },
						},
						{
							type: "toolCall",
							id: "call-old",
							name: "bash",
							arguments: { command: "echo old" },
						},
					],
				},
			}),
			// Paired bash toolResult within window (multi-block + image ignored + multi-byte UTF-8)
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-git",
					toolName: "bash",
					timestamp: now,
					content: [
						{ type: "text", text: "hello 🚀" }, // 6 + 4 = 10 bytes
						{ type: "image", data: "ignored" },
						{ type: "text", text: "world" }, // 5 bytes -> total 15
					],
				},
			}),
			// Old bash toolResult outside window -> ignored
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-old",
					toolName: "bash",
					timestamp: oldTime,
					content: [{ type: "text", text: "old output" }],
				},
			}),
			// Unpaired bash toolResult -> recorded under ""
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "unknown-id",
					toolName: "bash",
					timestamp: now,
					content: [{ type: "text", text: "orphan" }], // 6 bytes
				},
			}),
			// Non-bash toolResult
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					timestamp: now,
					content: [{ type: "text", text: "file content" }], // 12 bytes
				},
			}),
			// Valid outcome custom entry within window
			JSON.stringify({
				type: "custom",
				customType: ENTRY_TYPE,
				timestamp: new Date(now).toISOString(),
				data: {
					version: 1,
					tallies: [
						{
							tool: "read",
							category: "read",
							mechanism: "read-dedup",
							outcome: "filtered",
							count: 2,
							bytesBefore: 1000,
							bytesAfter: 200,
						},
					],
				},
			}),
			// Valid outcome custom entry BEFORE window -> skipped (not invalid)
			JSON.stringify({
				type: "custom",
				customType: ENTRY_TYPE,
				timestamp: new Date(oldTime).toISOString(),
				data: {
					version: 1,
					tallies: [
						{
							tool: "bash",
							category: "terminal",
							mechanism: "rtk:terminal",
							outcome: "unchanged",
							count: 1,
							bytesBefore: 600,
							bytesAfter: 600,
						},
					],
				},
			}),
			// Invalid outcome custom entry (bad data) -> invalidEntries++
			JSON.stringify({
				type: "custom",
				customType: ENTRY_TYPE,
				timestamp: new Date(now).toISOString(),
				data: { version: 99, tallies: [] },
			}),
			// Invalid outcome custom entry (missing timestamp) -> invalidEntries++
			JSON.stringify({
				type: "custom",
				customType: ENTRY_TYPE,
				data: {
					version: 1,
					tallies: [
						{
							tool: "read",
							category: "read",
							mechanism: "read-dedup",
							outcome: "unchanged",
							count: 1,
							bytesBefore: 600,
							bytesAfter: 600,
						},
					],
				},
			}),
			// Blank line -> skipped silently
			"",
			// Malformed JSON -> unreadableLines++
			"{not valid json",
			// Non-record JSON -> unreadableLines++
			"[1, 2, 3]",
			// Non-session entry -> ignored
			JSON.stringify({ type: "session", version: 1 }),
		];

		// Second file ensures toolCallId map does not leak across files and merges tallies
		const file2Lines = [
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-git", // same ID as file1, must NOT pair with file1's command
					toolName: "bash",
					timestamp: now,
					content: [{ type: "text", text: "1234" }], // 4 bytes under ""
				},
			}),
			JSON.stringify({
				type: "custom",
				customType: ENTRY_TYPE,
				timestamp: new Date(now).toISOString(),
				data: {
					version: 1,
					tallies: [
						{
							tool: "read",
							category: "read",
							mechanism: "read-dedup",
							outcome: "filtered",
							count: 1,
							bytesBefore: 500,
							bytesAfter: 100,
						},
					],
				},
			}),
		];

		await writeFile(file1, `${file1Lines.join("\n")}\n`, "utf8");
		await writeFile(file2, `${file2Lines.join("\n")}\n`, "utf8");

		const scan = await scanSessions([file1, vanished, file2], since);
		assert.equal(scan.files, 2);
		assert.equal(scan.unreadableLines, 2);
		assert.equal(scan.invalidEntries, 2);
		assert.deepEqual(scan.tools.get("bash"), { results: 3, bytes: 25 });
		assert.deepEqual(scan.tools.get("read"), { results: 1, bytes: 12 });
		assert.deepEqual(scan.bashCommands.get("git status"), {
			results: 1,
			bytes: 15,
		});
		assert.deepEqual(scan.bashCommands.get(""), { results: 2, bytes: 10 });
		assert.equal(scan.tallies.size, 1);
		const [mergedTally] = [...scan.tallies.values()];
		assert.deepEqual(mergedTally, {
			tool: "read",
			category: "read",
			mechanism: "read-dedup",
			outcome: "filtered",
			count: 3,
			bytesBefore: 1500,
			bytesAfter: 300,
		});
	});
});

describe("coverage.ts — classifyBash", () => {
	it("classifies rewritten, already rtk-wrapped, notRewritten, and unclassified commands", async () => {
		const seen: string[] = [];
		const commands = new Map<string, Usage>([
			["git status", { results: 2, bytes: 1000 }],
			["rtk pytest -q", { results: 1, bytes: 2000 }],
			["cd /repo && env -u NODE_ENV rtk git diff", { results: 1, bytes: 500 }],
			["python3 script.py", { results: 3, bytes: 1500 }],
			["unknown-cmd", { results: 1, bytes: 400 }],
			["", { results: 2, bytes: 300 }],
			["   ", { results: 1, bytes: 100 }],
		]);

		const coverage = await classifyBash(commands, async (cmd) => {
			seen.push(cmd);
			if (cmd === "git status") return true;
			if (cmd === "python3 script.py") return false;
			return undefined;
		});

		// Already-wrapped commands and blank commands must NOT be passed to rewrite()
		assert.equal(seen.includes("rtk pytest -q"), false);
		assert.equal(
			seen.includes("cd /repo && env -u NODE_ENV rtk git diff"),
			false,
		);
		assert.equal(seen.includes(""), false);
		assert.equal(seen.includes("   "), false);

		assert.deepEqual(coverage.rewritten, { results: 4, bytes: 3500 });
		assert.deepEqual(coverage.notRewritten, { results: 3, bytes: 1500 });
		assert.deepEqual(coverage.unclassified, { results: 4, bytes: 800 });
		assert.deepEqual(coverage.programs.get("python3"), {
			results: 3,
			bytes: 1500,
		});
	});

	it("extracts leading program across SHELL_SETUP, SHELL_PREFIX, SHELL_PREFIX_FLAGS_WITH_ARG, quotes, comments, and continuations", async () => {
		const cases: Array<[string, string]> = [
			["env -u FOO -C /tmp --unset BAR /usr/bin/python3 app.py", "python3"],
			["env -- -weird-bin", "-weird-bin"],
			["nice -n 10 --adjustment 5 /usr/local/bin/rg needle", "rg"],
			["exec -a myproc node server.js", "node"],
			["cd /app && export API_KEY='secret; rm -rf' && FOO=1 curl url", "curl"],
			["# author's comment\nbun run test", "bun"],
			["time \\\n  nohup make build", "make"],
			["cd /only-setup", "cd"],
			["FOO=1 BAR=2", "?"],
		];
		const commands = new Map<string, Usage>(
			cases.map(([cmd], i) => [cmd, { results: 1, bytes: (i + 1) * 100 }]),
		);

		const coverage = await classifyBash(commands, async () => false);
		for (let i = 0; i < cases.length; i++) {
			const expectedProg = cases[i]?.[1];
			assert.ok(expectedProg);
			assert.deepEqual(
				coverage.programs.get(expectedProg),
				{ results: 1, bytes: (i + 1) * 100 },
				`failed to extract "${expectedProg}" from "${cases[i]?.[0]}"`,
			);
		}
	});

	it("enforces the concurrency cap (<= 8 in-flight calls)", async () => {
		const commands = new Map<string, Usage>();
		for (let i = 0; i < 24; i++) {
			commands.set(`cmd-${i}`, { results: 1, bytes: 100 + i });
		}
		let active = 0;
		let maxActive = 0;

		const coverage = await classifyBash(commands, async () => {
			active++;
			if (active > maxActive) maxActive = active;
			await new Promise((resolve) => setTimeout(resolve, 10));
			active--;
			return true;
		});

		assert.ok(
			maxActive <= 8,
			`expected concurrency <= 8, observed ${maxActive}`,
		);
		assert.ok(
			maxActive > 1,
			`expected parallel workers, observed ${maxActive}`,
		);
		assert.equal(coverage.rewritten.results, 24);
	});

	it("enforces the 2,000 max distinct command cap prioritized by largest byte volume", async () => {
		const total = 2_005;
		const commands = new Map<string, Usage>();
		for (let i = 1; i <= total; i++) {
			commands.set(`cmd-${i}`, { results: 1, bytes: i });
		}
		let called = 0;
		const seenSmall: string[] = [];

		const coverage = await classifyBash(commands, async (cmd) => {
			called++;
			if (
				cmd === "cmd-1" ||
				cmd === "cmd-2" ||
				cmd === "cmd-3" ||
				cmd === "cmd-4" ||
				cmd === "cmd-5"
			) {
				seenSmall.push(cmd);
			}
			return true;
		});

		assert.equal(called, 2_000);
		assert.deepEqual(seenSmall, []);
		assert.equal(coverage.rewritten.results, 2_000);
		assert.deepEqual(coverage.unclassified, {
			results: 5,
			bytes: 1 + 2 + 3 + 4 + 5,
		});
	});
});

describe("coverage.ts — formatReport & windowStart", () => {
	it("formats a complete report with tools, bash breakdown, mechanisms, outcomes, and skipped warnings", () => {
		const tallies = new Map<string, Tally>();
		mergeTallies(tallies, {
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "filtered",
			count: 4,
			bytesBefore: 10_240,
			bytesAfter: 2_048,
		});
		mergeTallies(tallies, {
			tool: "read",
			category: "read",
			mechanism: "read-dedup",
			outcome: "unchanged",
			count: 2,
			bytesBefore: 1_500,
			bytesAfter: 1_500,
		});
		mergeTallies(tallies, {
			tool: "grep",
			category: "listing",
			mechanism: "rtk:listing",
			outcome: "failed",
			reason: "timeout",
			count: 1,
			bytesBefore: 2_000,
			bytesAfter: 2_000,
		});

		const scan: Scan = {
			files: 3,
			unreadableLines: 1,
			invalidEntries: 2,
			tools: new Map<string, Usage>([
				["bash", { results: 5, bytes: 4_096 }],
				["read", { results: 2, bytes: 2_097_152 }], // 2.0 MB
				["grep", { results: 1, bytes: 500 }],
				["custom_tool", { results: 1, bytes: 800 }],
			]),
			bashCommands: new Map(),
			tallies,
		};

		const report = formatReport({ days: 14, scope: "all" }, scan, {
			rewritten: { results: 2, bytes: 2_048 },
			notRewritten: { results: 2, bytes: 1_536 },
			unclassified: { results: 1, bytes: 512 },
			programs: new Map([["python3\u001b[31m", { results: 2, bytes: 1_536 }]]),
		});

		assert.match(
			report,
			/RTK coverage, last 14 days, all projects \(3 session files\)/,
		);
		assert.match(report, /2\.0 MB/);
		assert.match(report, /rtk rewrite, terminal, lossless/);
		assert.match(report, /listing, grep groups/);
		assert.match(report, /generic, lossless, dedup/);
		assert.match(report, /Savings by mechanism \(accepted replacements\)/);
		assert.match(report, /rtk:terminal\s+8\.0 KB saved in 4 results/);
		assert.match(report, /largest not rewritten: python3 1\.5 KB \(2\)/);
		assert.match(report, /filtered\s+4 results, 10\.0 KB -> 2\.0 KB/);
		assert.match(report, /unchanged\s+2 results/);
		assert.match(
			report,
			/original kept after a failed check\s+1 results \(timeout 1\)/,
		);
		assert.match(
			report,
			/Skipped 1 unreadable session lines and 2 invalid outcome entries\./,
		);
	});

	it("handles empty outcomes and truncates tool rows beyond top 15", () => {
		const tools = new Map<string, Usage>();
		for (let i = 1; i <= 18; i++) {
			tools.set(`tool_${i}`, { results: 1, bytes: i * 100 });
		}
		const scan: Scan = {
			files: 0,
			unreadableLines: 0,
			invalidEntries: 0,
			tools,
			bashCommands: new Map(),
			tallies: new Map(),
		};
		const report = formatReport({ days: 30, scope: "project" }, scan, {
			rewritten: { results: 0, bytes: 0 },
			notRewritten: { results: 0, bytes: 0 },
			unclassified: { results: 0, bytes: 0 },
			programs: new Map(),
		});

		assert.match(
			report,
			/RTK coverage, last 30 days, this project \(0 session files\)/,
		);
		assert.match(report, /… 3 more tools/);
		assert.match(report, /no recorded outcomes in this window/);
		assert.equal(report.includes("Savings by mechanism"), false);
		assert.equal(report.includes("Skipped "), false);
	});

	it("computes windowStart accurately", () => {
		const now = 1_700_000_000_000;
		assert.equal(windowStart(7, now), now - 7 * 86_400_000);
	});
});
