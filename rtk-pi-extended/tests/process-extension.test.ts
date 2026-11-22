import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Result } from "../bridge.ts";
import { unfactorSuffixes } from "../compact.ts";
import {
	ANY_START,
	type ContextResults,
	PassageIndex,
	ReadIndex,
} from "../dedup.ts";
import { createGate } from "../gate.ts";
import rtkPiExtended from "../index.ts";
import { ENTRY_TYPE, parseEntry } from "../outcomes.ts";
import type { Pipeline } from "../policy.ts";
import { type Call, type Dependencies, processRoute } from "../process.ts";

const RTK_PIPELINES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"rtk",
);

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

function makeDeps(overrides: Partial<Dependencies> = {}): {
	deps: Dependencies;
	reads: ReadIndex;
	passages: PassageIndex;
	visible: Map<string, string>;
} {
	const reads = overrides.reads ?? new ReadIndex();
	const passages = overrides.passages ?? new PassageIndex();
	const visible = new Map<string, string>();
	const deps: Dependencies = {
		cwd: "/repo",
		gate: () => false,
		rtk: async (): Promise<Result> => ({ kind: "unchanged" }),
		context: (): ContextResults => visible,
		reads,
		passages,
		...overrides,
	};
	return { deps, reads, passages, visible };
}

function makeLines(from: number, to: number, prefix = "line"): string[] {
	const out: string[] = [];
	for (let i = from; i <= to; i++) {
		out.push(`${prefix} ${String(i).padStart(3, "0")}: ${"abcdefghij".repeat(3)}`);
	}
	return out;
}

function makeCall(
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown> = {},
): Call {
	return { toolName, toolCallId, input };
}

after(async () => {
	await Promise.all(
		tempRoots.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("processRoute — read category", () => {
	it("returns undefined when path is missing and unchanged on non-parseable read message", async () => {
		const { deps } = makeDeps();
		const noPath = await processRoute(
			{ category: "read", text: "x".repeat(600) },
			makeCall("read", "r0"),
			deps,
		);
		assert.equal(noPath, undefined);

		const beyond = await processRoute(
			{
				category: "read",
				path: "/repo/a.ts",
				text: `[Line 999 is beyond end of file${" ".repeat(500)}]`,
			},
			makeCall("read", "r1", { path: "a.ts", offset: 999 }),
			deps,
		);
		assert.ok(beyond);
		assert.equal(beyond.text, undefined);
		assert.equal(beyond.sample.mechanism, "none");
		assert.equal(beyond.sample.outcome, "unchanged");
	});

	it("emits exact dedup stub preserving notice, and skips dedup once evicted from context", async () => {
		const { deps, visible } = makeDeps();
		const notice = "[Showing lines 1-30 of 200. Use offset=31 to continue.]";
		const body = makeLines(1, 30).join("\n");
		const fullText = `${body}\n\n${notice}`;

		const first = await processRoute(
			{ category: "read", path: "/repo/src/app.ts", text: fullText },
			makeCall("read", "read-1", { path: "src/app.ts", offset: 1 }),
			deps,
		);
		assert.ok(first);
		assert.equal(first.text, undefined);
		assert.equal(first.sample.outcome, "unchanged");
		visible.set("read-1", fullText);

		const second = await processRoute(
			{ category: "read", path: "/repo/src/app.ts", text: fullText },
			makeCall("read", "read-2", { path: "src/app.ts", offset: 1 }),
			deps,
		);
		assert.ok(second?.text);
		assert.equal(second.sample.mechanism, "read-dedup");
		assert.equal(second.sample.outcome, "filtered");
		assert.match(
			second.text,
			/\[rtk-pi-extended\] Unchanged: lines 1-30 of src\/app\.ts are identical to the read result of tool call read-1/,
		);
		assert.ok(second.text.endsWith(`\n\n${notice}`));

		// Clear forced marker by reading another file or simulating context eviction
		const { deps: deps2, visible: visible2 } = makeDeps();
		await processRoute(
			{ category: "read", path: "/repo/src/app.ts", text: fullText },
			makeCall("read", "read-1", { path: "src/app.ts", offset: 1 }),
			deps2,
		);
		// Not in visible context -> must NOT dedup
		assert.equal(visible2.size, 0);
		const afterEvict = await processRoute(
			{ category: "read", path: "/repo/src/app.ts", text: fullText },
			makeCall("read", "read-2", { path: "src/app.ts", offset: 1 }),
			deps2,
		);
		assert.equal(afterEvict?.text, undefined);
	});

	it("emits partial overlap stubs preserving unique leading and trailing lines verbatim", async () => {
		const { deps, visible } = makeDeps();
		const allLines = makeLines(1, 50);
		const middleBody = allLines.slice(14, 39).join("\n"); // lines 15-39
		await processRoute(
			{
				category: "read",
				path: "/repo/src/mid.ts",
				text: middleBody,
				offset: 15,
			},
			makeCall("read", "read-mid", { path: "src/mid.ts", offset: 15 }),
			deps,
		);
		visible.set("read-mid", middleBody);

		const fullRange = allLines.join("\n"); // lines 1-50
		const partial = await processRoute(
			{ category: "read", path: "/repo/src/mid.ts", text: fullRange },
			makeCall("read", "read-full", { path: "src/mid.ts", offset: 1 }),
			deps,
		);
		assert.ok(partial?.text);
		assert.equal(partial.sample.mechanism, "read-dedup");
		assert.match(
			partial.text,
			/\[rtk-pi-extended\] Partly unchanged: lines 1-50 of src\/mid\.ts follow, except lines 15-39/,
		);
		assert.ok(
			partial.text.includes(
				"[rtk-pi-extended: lines 15-39 omitted, see tool call read-mid]",
			),
		);
		// Verbatim leading and trailing lines preserved
		assert.ok(partial.text.includes(allLines[0] ?? ""));
		assert.ok(partial.text.includes(allLines[13] ?? ""));
		assert.ok(partial.text.includes(allLines[39] ?? ""));
		assert.ok(partial.text.includes(allLines[49] ?? ""));
		// Omitted middle line must not appear
		assert.equal(partial.text.includes(allLines[20] ?? ""), false);
	});

	it("handles widened pi-lens retry with read-forced and remains non-sticky on subsequent dedup", async () => {
		const { deps, visible } = makeDeps();
		const path = "/repo/src/widened.ts";
		const lines = makeLines(1, 60);
		const initialText = lines.slice(9, 50).join("\n"); // lines 10-50

		// 1. Initial verbatim read at offset 10
		const r1 = await processRoute(
			{ category: "read", path, text: initialText, offset: 10 },
			makeCall("read", "call-1", { path: "src/widened.ts", offset: 10 }),
			deps,
		);
		assert.equal(r1?.text, undefined);
		visible.set("call-1", initialText);

		// 2. Widened read: model requested offset=20, pi-lens widened to offset=10 (lines 10-50)
		//    Dedup replaces it and marks BOTH view.start (10) AND reqStart (20) replaced.
		const r2 = await processRoute(
			{ category: "read", path, text: initialText, offset: 10, blockIndex: 1 },
			makeCall("read", "call-2", { path: "src/widened.ts", offset: 20 }),
			deps,
		);
		assert.ok(r2?.text);
		assert.equal(r2.sample.mechanism, "read-dedup");

		// 3. Retry at requested offset=20 (widened to offset=5, lines 5-55) -> forcesFull(path, 20) is true!
		const widenedRetryText = lines.slice(4, 55).join("\n");
		const r3 = await processRoute(
			{
				category: "read",
				path,
				text: widenedRetryText,
				offset: 5,
				blockIndex: 1,
			},
			makeCall("read", "call-3", { path: "src/widened.ts", offset: 20 }),
			deps,
		);
		assert.ok(r3);
		assert.equal(r3.text, undefined);
		assert.equal(r3.sample.mechanism, "read-forced");
		assert.equal(r3.sample.outcome, "unchanged");
		visible.set("call-3", widenedRetryText);

		// 4. Subsequent read at offset=20 (or offset=5) is NOT sticky — deduplicates against call-3!
		const r4 = await processRoute(
			{
				category: "read",
				path,
				text: widenedRetryText,
				offset: 5,
				blockIndex: 1,
			},
			makeCall("read", "call-4", { path: "src/widened.ts", offset: 20 }),
			deps,
		);
		assert.ok(r4?.text);
		assert.equal(r4.sample.mechanism, "read-dedup");
		assert.ok(r4.text.includes("tool call call-3"));
	});

	it("summarizes lockfiles with >= 3 packages and skips lockfiles with < 3 packages", async () => {
		const { deps } = makeDeps();
		const packages = Array.from({ length: 12 }, (_, i) =>
			[
				`    "node_modules/pkg-${i}": {`,
				`      "version": "1.${i}.0",`,
				`      "resolved": "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.${i}.0.tgz",`,
				`      "integrity": "sha512-${"A".repeat(88)}"`,
				"    },",
			].join("\n"),
		).join("\n");
		const notice = "[Showing lines 1-65 of 500. Use offset=66 to continue.]";
		const lockText = `{\n  "packages": {\n${packages}\n  }\n}\n\n${notice}`;

		const res = await processRoute(
			{ category: "read", path: "/repo/package-lock.json", text: lockText },
			makeCall("read", "lock-1", { path: "package-lock.json" }),
			deps,
		);
		assert.ok(res?.text);
		assert.equal(res.sample.mechanism, "lockfile-summary");
		assert.equal(res.sample.outcome, "filtered");
		assert.ok(res.text.includes("pkg-0@1.0.0"));
		assert.ok(res.text.includes("pkg-11@1.11.0"));
		assert.equal(res.text.includes("sha512-"), false);
		assert.ok(
			res.text.includes(
				"Read the same path and offset again for the exact text.",
			),
		);
		assert.ok(res.text.endsWith(`\n\n${notice}`));

		// < 3 packages -> unchanged
		const smallLock = [
			'[[package]]\nname = "a"\nversion = "1.0.0"\nchecksum = "' +
				"x".repeat(300) +
				'"',
			'[[package]]\nname = "b"\nversion = "2.0.0"\nchecksum = "' +
				"y".repeat(300) +
				'"',
		].join("\n\n");
		const resSmall = await processRoute(
			{ category: "read", path: "/repo/Cargo.lock", text: smallLock },
			makeCall("read", "lock-2", { path: "Cargo.lock" }),
			deps,
		);
		assert.equal(resSmall?.text, undefined);
		assert.equal(resSmall?.sample.outcome, "unchanged");
	});

	it("trims long lines in minified files without splitting emoji surrogate pairs", async () => {
		const { deps } = makeDeps();
		// Put a 2-unit surrogate pair (🚀) right at UTF-16 index 299..300 so index 300 would split it.
		const longLine = `${"a".repeat(299)}🚀${"b".repeat(500)}`;
		const res = await processRoute(
			{ category: "read", path: "/repo/dist/app.min.js", text: longLine },
			makeCall("read", "min-1", { path: "dist/app.min.js" }),
			deps,
		);
		assert.ok(res?.text);
		assert.equal(res.sample.mechanism, "long-line-trim");
		assert.equal(res.text.isWellFormed(), true);
		// Truncated before high surrogate -> 299 'a's + ellipsis + [+502 chars]
		assert.ok(res.text.includes(`${"a".repeat(299)}…[+502 chars]`));
		assert.equal(res.text.includes("🚀"), false);
	});

	it("strips indentation on partial large JSON and bash JSON views while preserving small or complete JSON", async () => {
		const { deps } = makeDeps();
		const bigBody = Array.from(
			{ length: 400 },
			(_, i) =>
				`        "key_${String(i).padStart(4, "0")}": "value_${"x".repeat(25)}",`,
		).join("\n");
		assert.ok(Buffer.byteLength(bigBody) > 16 * 1024);

		// 1. Small JSON with notice (< 16 KiB) -> preserved
		const smallBody = Array.from(
			{ length: 40 },
			(_, i) => `        "k${i}": "value_${"x".repeat(10)}",`,
		).join("\n");
		const notice = "[Showing lines 1-40 of 500. Use offset=41 to continue.]";
		const smallRes = await processRoute(
			{
				category: "read",
				path: "/repo/small.json",
				text: `${smallBody}\n\n${notice}`,
			},
			makeCall("read", "j-small", { path: "small.json" }),
			deps,
		);
		assert.equal(smallRes?.text, undefined);

		// 2. Complete large JSON read (NO continuation notice) -> preserved
		const completeRes = await processRoute(
			{ category: "read", path: "/repo/complete.json", text: bigBody },
			makeCall("read", "j-complete", { path: "complete.json" }),
			deps,
		);
		assert.equal(completeRes?.text, undefined);

		// 3. Partial large JSON read (WITH continuation notice) -> json-indent
		const partialRes = await processRoute(
			{
				category: "read",
				path: "/repo/large.json",
				text: `${bigBody}\n\n${notice}`,
			},
			makeCall("read", "j-partial", { path: "large.json" }),
			deps,
		);
		assert.ok(partialRes?.text);
		assert.equal(partialRes.sample.mechanism, "json-indent");
		assert.ok(partialRes.text.includes('\n"key_0000":'));
		assert.ok(partialRes.text.endsWith(`\n\n${notice}`));

		// 4. Bash single-file view of large JSON -> json-indent
		const bashRes = await processRoute(
			{ category: "read", path: "/repo/large-bash.json", text: bigBody },
			makeCall("bash", "j-bash", { command: "cat large-bash.json" }),
			deps,
		);
		assert.ok(bashRes?.text);
		assert.equal(bashRes.sample.mechanism, "json-indent");
	});

	it("condenses .log files via RTK terminal profile and surfaces failures or gate skips", async () => {
		const logText = "INFO starting\n".repeat(60);
		const calls: Array<{ tool: string; pipeline: Pipeline }> = [];

		// Gate false -> skips RTK
		const { deps: skippedDeps } = makeDeps({
			gate: () => false,
			rtk: async (tool, _t, pipeline) => {
				calls.push({ tool, pipeline });
				return { kind: "unchanged" };
			},
		});
		const skipped = await processRoute(
			{ category: "read", path: "/repo/server.log", text: logText },
			makeCall("read", "log-skip", { path: "server.log" }),
			skippedDeps,
		);
		assert.equal(calls.length, 0);
		assert.equal(skipped?.text, undefined);

		// Gate true + filtered -> rtk:terminal
		const { deps: okDeps } = makeDeps({
			gate: () => true,
			rtk: async (tool, _t, pipeline) => {
				calls.push({ tool, pipeline });
				return {
					kind: "filtered",
					text: "INFO starting\n[x60]\n[full output: rtk recall 0123456789abcdef]",
				};
			},
		});
		const okRes = await processRoute(
			{ category: "read", path: "/repo/server.log.1", text: logText },
			makeCall("read", "log-ok", { path: "server.log.1" }),
			okDeps,
		);
		assert.deepEqual(calls, [{ tool: "read", pipeline: "terminal" }]);
		assert.ok(okRes?.text);
		assert.equal(okRes.sample.mechanism, "rtk:terminal");
		assert.ok(okRes.text.includes("Log condensed by RTK:"));

		// Gate true + failed -> failure propagated
		const { deps: failDeps } = makeDeps({
			gate: () => true,
			rtk: async () => ({ kind: "failed", reason: "timeout" }),
		});
		const failRes = await processRoute(
			{ category: "read", path: "/repo/server.log", text: logText },
			makeCall("read", "log-fail", { path: "server.log" }),
			failDeps,
		);
		assert.equal(failRes?.text, undefined);
		assert.equal(failRes?.failure, "timeout");
		assert.equal(failRes?.sample.outcome, "failed");
		assert.equal(failRes?.sample.reason, "timeout");
	});

	it("marks ANY_START after condensing a Bash single-file view so any subsequent read offset is forced full", async () => {
		const { deps, reads } = makeDeps();
		const path = "/repo/package-lock.json";
		const packages = Array.from({ length: 10 }, (_, i) =>
			[
				`    "node_modules/dep-${i}": {`,
				`      "version": "2.${i}.0",`,
				`      "integrity": "sha512-${"B".repeat(88)}"`,
				"    },",
			].join("\n"),
		).join("\n");
		const lockText = `{\n  "packages": {\n${packages}\n  }\n}`;

		const bashView = await processRoute(
			{ category: "read", path, text: lockText },
			makeCall("bash", "b-view", { command: "cat package-lock.json" }),
			deps,
		);
		assert.ok(bashView?.text);
		assert.ok(
			bashView.text.includes("Read the file with the read tool for the exact text."),
		);
		assert.equal(reads.forcesFull(path, ANY_START), true);
		assert.equal(reads.forcesFull(path, 1), true);
		assert.equal(reads.forcesFull(path, 77), true);

		// Subsequent read at offset 77 returns read-forced and clears ANY_START
		const readRetry = await processRoute(
			{ category: "read", path, text: lockText, offset: 77 },
			makeCall("read", "r-after-bash", {
				path: "package-lock.json",
				offset: 77,
			}),
			deps,
		);
		assert.equal(readRetry?.text, undefined);
		assert.equal(readRetry?.sample.mechanism, "read-forced");
		assert.equal(reads.forcesFull(path, 1), false);
		assert.equal(reads.forcesFull(path, 77), false);
	});
});

describe("processRoute — terminal category", () => {
	it("runs dedupPassages BEFORE factorSuffixes (zero cross-turn [^1] collisions) and indexes pre-factored text", async () => {
		const { deps, passages, visible } = makeDeps();
		const suffix1 =
			" --target=x86_64-unknown-linux-gnu --release --features=full-telemetry-v1";
		const suffix2 =
			" --target=aarch64-apple-darwin-gnu --debug   --features=minimal-local-v2";

		const makeFactorablePassage = (suffix: string): string =>
			Array.from(
				{ length: 6 },
				(_, i) => `compiling crate_module_number_${i}${suffix}`,
			).join("\n");

		const sharedPlainPassage = Array.from(
			{ length: 6 },
			(_, i) =>
				`static diagnostic banner paragraph ${i}: ${String.fromCharCode(97 + i).repeat(42)} [end-${i}]`,
		).join("\n");

		const turn1Passage = makeFactorablePassage(suffix1);
		const turn1Text = `${sharedPlainPassage}\n\n${turn1Passage}\n\ndone turn 1`;

		const res1 = await processRoute(
			{ category: "terminal", text: turn1Text },
			makeCall("bash", "term-1", { command: "cargo build" }),
			deps,
		);
		assert.ok(res1?.text);
		assert.equal(res1.sample.mechanism, "suffix-factor");
		assert.ok(res1.text.includes(`[^1]:${suffix1}`));
		assert.equal(unfactorSuffixes(res1.text), turn1Text);

		// Verify PassageIndex recorded PRE-FACTORED passage, NOT the [^1]-factored form
		assert.deepEqual(passages.calls("bash", turn1Passage), ["term-1"]);
		const factoredBodyOnly = res1.text.split("\n\n")[1] ?? "";
		assert.ok(factoredBodyOnly.includes("[^1]"));
		assert.deepEqual(passages.calls("bash", factoredBodyOnly), []);

		// Turn 1 delivered output is now in model context
		visible.set("term-1", res1.text);

		// Turn 2 has SAME prefixes with DIFFERENT suffix2 -> MUST NOT collide with Turn 1's [^1]!
		// AND repeats sharedPlainPassage -> triggers BOTH passage-dedup AND suffix-factor!
		const turn2Passage = makeFactorablePassage(suffix2);
		const turn2Text = `${sharedPlainPassage}\n\n${turn2Passage}\n\ndone turn 2`;

		const res2 = await processRoute(
			{ category: "terminal", text: turn2Text },
			makeCall("bash", "term-2", { command: "cargo build --debug" }),
			deps,
		);
		assert.ok(res2?.text);
		assert.equal(res2.sample.mechanism, "passage-dedup+suffix-factor");
		// Shared plain passage was deduped against term-1
		assert.ok(res2.text.includes("tool call term-1"));
		// Turn 2's own suffix2 is intact and NOT falsely replaced with term-1's suffix1!
		assert.ok(res2.text.includes(`[^1]:${suffix2}`));
		assert.equal(res2.text.includes(suffix1), false);
		const expanded2 = unfactorSuffixes(res2.text);
		assert.ok(expanded2.includes(turn2Passage));
	});

	it("skips RTK on wrapped commands unless raw terminal escapes or cap limits are present", async () => {
		let rtkCalls = 0;
		const { deps } = makeDeps({
			gate: () => true,
			rtk: async (_tool, _text) => {
				rtkCalls++;
				return {
					kind: "filtered",
					text: "condensed\n[full output: rtk recall 0123456789abcdef]",
				};
			},
		});

		// 1. Clean short wrapped output -> skips RTK and returns undefined
		const clean = await processRoute(
			{ category: "terminal", text: "clean wrapped line\n".repeat(40), wrapped: true },
			makeCall("bash", "w-1", { command: "rtk git status" }),
			deps,
		);
		assert.equal(rtkCalls, 0);
		assert.equal(clean, undefined);

		// 2. Wrapped output with ANSI escape -> runs RTK
		const ansi = await processRoute(
			{
				category: "terminal",
				text: "\u001b[32mgreen line\u001b[0m\n".repeat(40),
				wrapped: true,
			},
			makeCall("bash", "w-2", { command: "rtk git status" }),
			deps,
		);
		assert.equal(rtkCalls, 1);
		assert.ok(ansi?.text);
		assert.equal(ansi.sample.mechanism, "rtk:terminal");

		// 3. Wrapped output exceeding 300-line cap -> runs RTK
		const overCap = await processRoute(
			{
				category: "terminal",
				text: "line\n".repeat(310),
				wrapped: true,
			},
			makeCall("bash", "w-3", { command: "rtk git log" }),
			deps,
		);
		assert.equal(rtkCalls, 2);
		assert.ok(overCap?.text);

		// 4. Clean wrapped JSON still applies lossless json-compact without calling RTK
		const wrappedJson = JSON.stringify(
			{ items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: "item" })) },
			null,
			4,
		);
		const jsonRes = await processRoute(
			{ category: "terminal", text: wrappedJson, wrapped: true },
			makeCall("bash", "w-4", { command: "rtk gh api /items" }),
			deps,
		);
		assert.equal(rtkCalls, 2);
		assert.ok(jsonRes?.text);
		assert.equal(jsonRes.sample.mechanism, "json-compact");
	});

	it("skips grep-group on raw grep/egrep/fgrep bash commands while grouping rg output", async () => {
		const { deps } = makeDeps();
		const grepOut = Array.from(
			{ length: 20 },
			(_, i) => `src/deeply/nested/module/feature.ts:${i + 1}: const val${i} = needle;`,
		).join("\n");

		for (const cmd of [
			"grep -rn needle src/",
			"egrep -n 'needle|other' src/",
			"fgrep -n needle src/",
		]) {
			const res = await processRoute(
				{ category: "terminal", text: grepOut },
				makeCall("bash", `g-${cmd}`, { command: cmd }),
				deps,
			);
			assert.equal(res?.text, undefined, `expected ${cmd} to skip grep-group`);
		}

		const rgRes = await processRoute(
			{ category: "terminal", text: grepOut },
			makeCall("bash", "g-rg", { command: "rg -n needle src/" }),
			deps,
		);
		assert.ok(rgRes?.text);
		assert.equal(rgRes.sample.mechanism, "grep-group");
		assert.ok(rgRes.text.startsWith("src/deeply/nested/module/feature.ts\n 1:"));
	});

	it("preserves trailing bash trailer and RTK recall hint across lossless steps", async () => {
		const trailer =
			"[Showing last 200 lines. Full output: /tmp/pi-bash-123.log]\n\nCommand exited with code 2";
		const hint = "\n[full output: rtk recall 0123456789abcdef]";
		const grepBody = Array.from(
			{ length: 20 },
			(_, i) => `packages/core/src/long/path/file.ts:${i + 1}: match line ${i}`,
		).join("\n");
		const original = `${"\u001b[31m"}${grepBody}\n\n${trailer}`;

		const { deps } = makeDeps({
			gate: () => true,
			rtk: async () => ({
				kind: "filtered",
				text: `${grepBody}\n\n${trailer}${hint}`,
			}),
		});

		const res = await processRoute(
			{ category: "terminal", text: original },
			makeCall("bash", "trailer-1", { command: "rg -n match packages/" }),
			deps,
		);
		assert.ok(res?.text);
		assert.equal(res.sample.mechanism, "rtk:terminal+grep-group");
		assert.ok(res.text.startsWith("packages/core/src/long/path/file.ts\n 1:"));
		assert.ok(res.text.endsWith(`\n\n${trailer}${hint}`));
	});

	it("falls back safely on RTK failure and still runs lossless rewrites when worthwhile", async () => {
		const plain = "error line\n".repeat(80);
		const { deps: failOnly } = makeDeps({
			gate: () => true,
			rtk: async () => ({ kind: "failed", reason: "process" }),
		});
		const res1 = await processRoute(
			{ category: "terminal", text: plain },
			makeCall("bash", "f-1", { command: "make test" }),
			failOnly,
		);
		assert.equal(res1?.text, undefined);
		assert.equal(res1?.failure, "process");
		assert.equal(res1?.sample.outcome, "failed");
		assert.equal(res1?.sample.mechanism, "rtk:terminal");
		assert.equal(res1?.sample.reason, "process");

		// RTK fails, but lossless json-compact still compresses -> returns filtered + failure
		const prettyJson = JSON.stringify(
			{ records: Array.from({ length: 20 }, (_, i) => ({ index: i, ok: true })) },
			null,
			4,
		);
		const { deps: failPlusLossless } = makeDeps({
			gate: () => true,
			rtk: async () => ({ kind: "failed", reason: "timeout" }),
		});
		const res2 = await processRoute(
			{ category: "terminal", text: prettyJson },
			makeCall("bash", "f-2", { command: "curl http://localhost/api" }),
			failPlusLossless,
		);
		assert.ok(res2?.text);
		assert.equal(res2.failure, "timeout");
		assert.equal(res2.sample.outcome, "filtered");
		assert.equal(res2.sample.mechanism, "json-compact");
	});
});

describe("processRoute — listing category", () => {
	it("applies grep-group on Pi grep tool and skips it on non-grep listing tools", async () => {
		const { deps } = makeDeps();
		const grepOut = Array.from(
			{ length: 20 },
			(_, i) => `src/components/editor/LongComponentName.tsx:${i + 1}: handleChange()`,
		).join("\n");

		const grepRes = await processRoute(
			{ category: "listing", text: grepOut },
			makeCall("grep", "ls-grep", { pattern: "handleChange" }),
			deps,
		);
		assert.ok(grepRes?.text);
		assert.equal(grepRes.sample.mechanism, "grep-group");
		assert.ok(
			grepRes.text.startsWith(
				"src/components/editor/LongComponentName.tsx\n 1:",
			),
		);

		const findRes = await processRoute(
			{ category: "listing", text: grepOut },
			makeCall("find", "ls-find", { pattern: "*.tsx" }),
			deps,
		);
		assert.equal(findRes?.text, undefined);
	});

	it("skips RTK cap on multi-file >300-line FFF output and runs RTK cap on single-file >300-line FFF output via real createGate", async () => {
		const realGate = createGate(RTK_PIPELINES_DIR);
		let rtkCalls = 0;
		const { deps } = makeDeps({
			gate: realGate,
			rtk: async (_tool, text) => {
				rtkCalls++;
				const lines = text.split("\n");
				const capped = [
					...lines.slice(0, 50),
					`[... ${lines.length - 250} lines elided ...]`,
					...lines.slice(-200),
				].join("\n");
				return {
					kind: "filtered",
					text: `${capped}\n[full output: rtk recall 0123456789abcdef]`,
				};
			},
		});

		// Multi-file >300-line FFF: headings spaced every 20 lines so head 50 + tail 200 drops middle headings
		const multiSections: string[] = [];
		for (let f = 0; f < 18; f++) {
			multiSections.push(`src/mod-${f}/file.ts`);
			for (let line = 1; line <= 20; line++) {
				multiSections.push(` ${line}: match in mod-${f} line ${line}`);
			}
			multiSections.push("");
		}
		const multiFileFff = multiSections.join("\n");
		assert.ok(multiFileFff.split("\n").length > 300);

		const multiRes = await processRoute(
			{ category: "listing", text: multiFileFff },
			makeCall("ffgrep", "fff-multi"),
			deps,
		);
		assert.equal(rtkCalls, 0);
		assert.equal(multiRes?.text, undefined);

		// Single-file >300-line FFF: 1 heading at line 1 + 350 numbered lines -> head 50 + tail 200 preserves heading!
		const singleLines = [
			"src/huge-file.ts",
			...Array.from(
				{ length: 350 },
				(_, i) => ` ${i + 1}: const entry_${i + 1} = ${i + 1};`,
			),
		];
		const singleFileFff = singleLines.join("\n");
		const singleRes = await processRoute(
			{ category: "listing", text: singleFileFff },
			makeCall("ffgrep", "fff-single"),
			deps,
		);
		assert.equal(rtkCalls, 1);
		assert.ok(singleRes?.text);
		assert.equal(singleRes.sample.mechanism, "rtk:listing");
		assert.ok(singleRes.text.includes("lines elided"));
	});
});

describe("processRoute — generic category", () => {
	it("runs excerpt-dedup (multi-hunk), passage-dedup, and suffix-factor in order and indexes pre-factored passages", async () => {
		const { deps, reads, passages, visible } = makeDeps();

		// Record two prior reads in ReadIndex & visible context
		const linesA = makeLines(1, 20, "alpha");
		const linesB = makeLines(1, 20, "beta");
		reads.record("/repo/src/a.ts", "read-a", {
			start: 1,
			lines: linesA,
			body: linesA.join("\n"),
		});
		reads.record("/repo/src/b.ts", "read-b", {
			start: 1,
			lines: linesB,
			body: linesB.join("\n"),
		});
		visible.set("read-a", linesA.join("\n"));
		visible.set("read-b", linesB.join("\n"));

		// Record an earlier generic passage
		const repeatedPassage = Array.from(
			{ length: 6 },
			(_, i) =>
				`Previously reported MCP explanation paragraph line ${i} with context ${"p".repeat(25)}`,
		).join("\n");
		passages.record(
			"mcp_search",
			"mcp-prev",
			`${repeatedPassage}\n\nprevious footer`,
		);
		visible.set("mcp-prev", `${repeatedPassage}\n\nprevious footer`);

		// Build multi-hunk numbered excerpt (hunk 1 from a.ts matches, hunk 2 from b.ts matches, hunk 3 from a.ts modified)
		const hunkA = linesA
			.slice(0, 10)
			.map((l, i) => `${i + 1}\t${l}`)
			.join("\n");
		const hunkB = linesB
			.slice(0, 10)
			.map((l, i) => `${i + 1}\t${l}`)
			.join("\n");
		const modifiedHunk = linesA
			.slice(10, 18)
			.map((l, i) => `${i + 11}\tCHANGED ${l}`)
			.join("\n");

		const suffix =
			" -> resolved via symbol table cache hit in workspace package index";
		const factorBlock = Array.from(
			{ length: 5 },
			(_, i) => `reference_${i}${suffix}`,
		).join("\n");

		const genericText = [
			"**`src/a.ts`**",
			`\`\`\`ts\n${hunkA}\n\`\`\``,
			"**`src/b.ts`**",
			`\`\`\`ts\n${hunkB}\n\`\`\``,
			"**`src/a.ts`**",
			`\`\`\`ts\n${modifiedHunk}\n\`\`\``,
			repeatedPassage,
			factorBlock,
			"final summary line",
		].join("\n\n");

		const res = await processRoute(
			{ category: "generic", text: genericText },
			makeCall("mcp_search", "mcp-1"),
			deps,
		);
		assert.ok(res?.text);
		assert.equal(
			res.sample.mechanism,
			"excerpt-dedup+passage-dedup+suffix-factor",
		);
		assert.ok(
			res.text.includes(
				"```ts\n[rtk-pi-extended: lines 1-10 omitted; identical text is in the read result of tool call read-a earlier in this conversation]\n```",
			),
		);
		assert.ok(
			res.text.includes(
				"```ts\n[rtk-pi-extended: lines 1-10 omitted; identical text is in the read result of tool call read-b earlier in this conversation]\n```",
			),
		);
		// Modified hunk stayed verbatim
		assert.ok(res.text.includes("11\tCHANGED alpha 011:"));
		// Repeated passage omitted
		assert.ok(res.text.includes("tool call mcp-prev"));
		// Suffix factored
		assert.ok(res.text.includes(`[^1]:${suffix}`));
		// Pre-factored passage indexed in PassageIndex
		assert.deepEqual(passages.calls("mcp_search", factorBlock), ["mcp-1"]);
	});

	it("applies json-compact and grep-group on generic tool outputs and preserves RTK recall hint", async () => {
		const hint = "\n[full output: rtk recall fedcba0123456789]";
		const prettyJson = JSON.stringify(
			{ results: Array.from({ length: 15 }, (_, i) => ({ id: i, score: 0.9 })) },
			null,
			4,
		);
		const { deps: jsonDeps } = makeDeps({
			gate: () => true,
			rtk: async () => ({ kind: "filtered", text: `${prettyJson}${hint}` }),
		});
		const jsonRes = await processRoute(
			{ category: "generic", text: `\u001b[33m${prettyJson}` },
			makeCall("mcp_json", "mj-1"),
			jsonDeps,
		);
		assert.ok(jsonRes?.text);
		assert.equal(jsonRes.sample.mechanism, "rtk:generic+json-compact");
		assert.ok(jsonRes.text.endsWith(hint));

		const { deps: grepDeps } = makeDeps();
		const grepOut = Array.from(
			{ length: 18 },
			(_, i) => `packages/service/src/handler.ts:${i + 1}: return ok(${i});`,
		).join("\n");
		const grepRes = await processRoute(
			{ category: "generic", text: grepOut },
			makeCall("codegraph_search", "cg-1"),
			grepDeps,
		);
		assert.ok(grepRes?.text);
		assert.equal(grepRes.sample.mechanism, "grep-group");
	});
});

// ---------------------------------------------------------------------------
// Harness for full rtk-pi-extended/index.ts extension integration tests
// ---------------------------------------------------------------------------

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

type ExecHandler = (
	command: string,
	args: string[],
	options?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

interface Harness {
	notifications: Array<{ message: string; level: string }>;
	setLeaf(leaf: string | null): void;
	addProjectionToolResult(toolCallId: string, text: string): void;
	clearProjection(): void;
	setExec(handler: ExecHandler): void;
	emitToolResult(
		event: Partial<ToolResultEvent> & {
			toolName: string;
			toolCallId: string;
			content: ToolResultEvent["content"];
		},
		signal?: AbortSignal,
	): Promise<ToolResultEventResult | undefined>;
	emitTurnEnd(
		entries?: TurnEndEvent["entries"],
	): TurnEndEventResult | undefined;
	emitSessionStart(): void;
	emitSessionCompact(): void;
	emitSessionTree(): void;
	emitSessionShutdown(): Promise<void>;
	runCoverage(args: string): Promise<void>;
}

function createExtensionHarness(options: {
	cwd?: string;
	sessionDir: string;
	hasUI?: boolean;
}): Harness {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	let execHandler: ExecHandler = async () => ({
		stdout: "",
		stderr: "",
		code: 1,
		killed: false,
	});

	const pi = {
		on(event: string, fn: (...args: unknown[]) => unknown): void {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		registerCommand(
			name: string,
			spec: {
				description: string;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		): void {
			commands.set(name, spec.handler);
		},
		exec(
			cmd: string,
			args: string[],
			opts?: { timeout?: number; signal?: AbortSignal },
		): Promise<ExecResult> {
			return execHandler(cmd, args, opts);
		},
	};

	rtkPiExtended(pi as unknown as ExtensionAPI);

	const notifications: Array<{ message: string; level: string }> = [];
	let leafId: string | null = "leaf-0";
	const projectionMessages: Array<{
		role: "toolResult";
		toolCallId: string;
		content: Array<{ type: "text"; text: string }>;
	}> = [];

	const makeCtx = (signal?: AbortSignal): ExtensionContext =>
		({
			cwd: options.cwd ?? "/repo",
			hasUI: options.hasUI ?? true,
			...(signal ? { signal } : {}),
			ui: {
				notify(message: string, level: string): void {
					notifications.push({ message, level });
				},
			},
			sessionManager: {
				getLeafId: () => leafId,
				getSessionDir: () => options.sessionDir,
				buildSessionProjection: () => ({ messages: projectionMessages }),
			},
		}) as unknown as ExtensionContext;

	return {
		notifications,
		setLeaf(leaf: string | null): void {
			leafId = leaf;
		},
		addProjectionToolResult(toolCallId: string, text: string): void {
			projectionMessages.push({
				role: "toolResult",
				toolCallId,
				content: [{ type: "text", text }],
			});
			leafId = `leaf-${projectionMessages.length}`;
		},
		clearProjection(): void {
			projectionMessages.length = 0;
			leafId = "leaf-cleared";
		},
		setExec(handler: ExecHandler): void {
			execHandler = handler;
		},
		async emitToolResult(partial, signal) {
			const [fn] = handlers.get("tool_result") ?? [];
			assert.ok(fn, "tool_result handler not registered");
			const event: ToolResultEvent = {
				type: "tool_result",
				input: {},
				isError: false,
				...partial,
			} as ToolResultEvent;
			return (await fn(event, makeCtx(signal))) as
				| ToolResultEventResult
				| undefined;
		},
		emitTurnEnd(entries = []) {
			const [fn] = handlers.get("turn_end") ?? [];
			assert.ok(fn, "turn_end handler not registered");
			const event = { type: "turn_end", entries } as unknown as TurnEndEvent;
			return fn(event) as TurnEndEventResult | undefined;
		},
		emitSessionStart(): void {
			for (const fn of handlers.get("session_start") ?? []) fn();
		},
		emitSessionCompact(): void {
			for (const fn of handlers.get("session_compact") ?? []) fn();
		},
		emitSessionTree(): void {
			for (const fn of handlers.get("session_tree") ?? []) fn();
		},
		async emitSessionShutdown(): Promise<void> {
			for (const fn of handlers.get("session_shutdown") ?? []) {
				await fn();
			}
		},
		async runCoverage(args: string): Promise<void> {
			const handler = commands.get("rtk-coverage");
			assert.ok(handler, "rtk-coverage command not registered");
			await handler(args, makeCtx() as unknown as ExtensionCommandContext);
		},
	};
}

describe("rtk-pi-extended/index.ts — full extension hooks", () => {
	it("rewrites tool_result preserving structuredContent and updating multi-block blockIndex", async () => {
		const sessionDir = await makeTempDir("rtk-ext-rewrite-");
		const harness = createExtensionHarness({ sessionDir });

		// 1. Single-block grep result with structuredContent preserved
		const grepOut = Array.from(
			{ length: 20 },
			(_, i) => `src/services/authentication/session.ts:${i + 1}: verifyToken(${i});`,
		).join("\n");
		const structured = { matchCount: 20, truncated: false };
		const grepRes = await harness.emitToolResult({
			toolName: "grep",
			toolCallId: "g1",
			input: { pattern: "verifyToken" },
			content: [{ type: "text", text: grepOut }],
			structuredContent: structured,
		});
		assert.ok(grepRes?.content);
		assert.equal(grepRes.content.length, 1);
		assert.equal(grepRes.content[0]?.type, "text");
		if (grepRes.content[0]?.type === "text") {
			assert.ok(
				grepRes.content[0].text.startsWith(
					"src/services/authentication/session.ts\n 1:",
				),
			);
		}
		assert.deepEqual(grepRes.structuredContent, structured);

		// 2. Multi-block pi-lens widened read updates ONLY blockIndex 1 and omits undefined structuredContent
		const fileBody = makeLines(1, 30).join("\n");
		const firstRead = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r-base",
			input: { path: "src/app.ts", offset: 1 },
			content: [{ type: "text", text: fileBody }],
		});
		assert.equal(firstRead, undefined);
		harness.addProjectionToolResult("r-base", fileBody);

		const banner =
			"[pi-lens: read widened from lines 5-15; this shows lines 1-30 of src/app.ts]";
		const widenedRead = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r-wide",
			input: { path: "src/app.ts", offset: 5 },
			content: [
				{ type: "text", text: banner },
				{ type: "text", text: fileBody },
			],
		});
		assert.ok(widenedRead?.content);
		assert.equal(widenedRead.content.length, 2);
		assert.deepEqual(widenedRead.content[0], { type: "text", text: banner });
		assert.equal(widenedRead.content[1]?.type, "text");
		if (widenedRead.content[1]?.type === "text") {
			assert.match(widenedRead.content[1].text, /Unchanged: lines 1-30/);
		}
		assert.equal("structuredContent" in widenedRead, false);
	});

	it("invalidates ReadIndex on successful edit/write but NOT when edit/write errors", async () => {
		const sessionDir = await makeTempDir("rtk-ext-invalidate-");
		const harness = createExtensionHarness({ sessionDir });
		const body = makeLines(1, 30).join("\n");

		// Initial read recorded
		await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r1",
			input: { path: "src/file.ts" },
			content: [{ type: "text", text: body }],
		});
		harness.addProjectionToolResult("r1", body);

		// Failed edit -> MUST NOT invalidate ReadIndex
		await harness.emitToolResult({
			toolName: "edit",
			toolCallId: "e-err",
			input: { path: "src/file.ts" },
			isError: true,
			content: [{ type: "text", text: "match not found" }],
		});
		const afterErrEdit = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r2",
			input: { path: "src/file.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.ok(afterErrEdit?.content, "errored edit must not invalidate read dedup");

		// Successful edit -> invalidates ReadIndex (and clears replaced marker)
		await harness.emitToolResult({
			toolName: "edit",
			toolCallId: "e-ok",
			input: { path: "src/file.ts" },
			isError: false,
			content: [{ type: "text", text: "edited" }],
		});
		const afterOkEdit = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r3",
			input: { path: "src/file.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.equal(afterOkEdit, undefined, "successful edit must invalidate ReadIndex");
		harness.addProjectionToolResult("r3", body);

		// Failed write -> MUST NOT invalidate ReadIndex
		await harness.emitToolResult({
			toolName: "write",
			toolCallId: "w-err",
			input: { path: "src/file.ts" },
			isError: true,
			content: [{ type: "text", text: "EACCES" }],
		});
		const afterErrWrite = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r4",
			input: { path: "src/file.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.ok(afterErrWrite?.content, "errored write must not invalidate read dedup");

		// Successful write -> invalidates ReadIndex
		await harness.emitToolResult({
			toolName: "write",
			toolCallId: "w-ok",
			input: { path: "src/file.ts" },
			isError: false,
			content: [{ type: "text", text: "wrote file" }],
		});
		const afterOkWrite = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r5",
			input: { path: "src/file.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.equal(afterOkWrite, undefined, "successful write must invalidate ReadIndex");
	});

	it("appends validated rtk-pi-extended custom entry on turn_end and resets state across session lifecycle events", async () => {
		const sessionDir = await makeTempDir("rtk-ext-lifecycle-");
		const harness = createExtensionHarness({ sessionDir });
		const body = makeLines(1, 30).join("\n");

		// Empty turn_end returns undefined
		assert.equal(harness.emitTurnEnd(), undefined);

		await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r1",
			input: { path: "src/life.ts" },
			content: [{ type: "text", text: body }],
		});
		harness.addProjectionToolResult("r1", body);
		const deduped = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r2",
			input: { path: "src/life.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.ok(deduped?.content);

		// turn_end preserves existing entries and appends valid rtk-pi-extended custom entry
		const existing = [{ type: "custom", customType: "other", data: { a: 1 } }];
		const turnRes = harness.emitTurnEnd(
			existing as unknown as TurnEndEvent["entries"],
		);
		assert.ok(turnRes?.entries);
		assert.equal(turnRes.entries.length, 2);
		assert.deepEqual(turnRes.entries[0], existing[0]);
		const added = turnRes.entries[1] as {
			type: string;
			customType: string;
			data: unknown;
		};
		assert.equal(added.type, "custom");
		assert.equal(added.customType, ENTRY_TYPE);
		const parsed = parseEntry(added.data);
		assert.ok(parsed);
		assert.equal(parsed.tallies.length, 2); // 1 unchanged + 1 filtered
		// Second turn_end is empty
		assert.equal(harness.emitTurnEnd(), undefined);

		// session_compact clears ReadIndex/PassageIndex (so next read is NOT deduped)
		await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r3",
			input: { path: "src/compact.ts" },
			content: [{ type: "text", text: body }],
		});
		harness.addProjectionToolResult("r3", body);
		harness.emitSessionCompact();
		const afterCompact = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r4",
			input: { path: "src/compact.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.equal(afterCompact, undefined);
		// session_compact kept pending ledger entries until turn_end
		assert.ok(harness.emitTurnEnd());

		// session_tree clears BOTH ledger and indexes
		await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r5",
			input: { path: "src/tree.ts" },
			content: [{ type: "text", text: body }],
		});
		harness.addProjectionToolResult("r5", body);
		harness.emitSessionTree();
		assert.equal(harness.emitTurnEnd(), undefined);
		const afterTree = await harness.emitToolResult({
			toolName: "read",
			toolCallId: "r6",
			input: { path: "src/tree.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.equal(afterTree, undefined);

		// session_shutdown aborts lifetime and clears ledger; subsequent calls are no-ops
		await harness.emitSessionShutdown();
		assert.equal(harness.emitTurnEnd(), undefined);
		const grepOut = Array.from(
			{ length: 20 },
			(_, i) => `src/long/path/module.ts:${i + 1}: symbol(${i});`,
		).join("\n");
		assert.equal(
			await harness.emitToolResult({
				toolName: "grep",
				toolCallId: "after-shut",
				input: { pattern: "symbol" },
				content: [{ type: "text", text: grepOut }],
			}),
			undefined,
		);

		// session_start recreates lifetime and re-enables filtering!
		harness.emitSessionStart();
		const afterRestart = await harness.emitToolResult({
			toolName: "grep",
			toolCallId: "after-start",
			input: { pattern: "symbol" },
			content: [{ type: "text", text: grepOut }],
		});
		assert.ok(afterRestart?.content);
	});

	it("bypasses filtering completely when RTK_DISABLED=1", async () => {
		const sessionDir = await makeTempDir("rtk-ext-disabled-");
		const harness = createExtensionHarness({ sessionDir });
		const prev = process.env.RTK_DISABLED;
		process.env.RTK_DISABLED = "1";
		try {
			const grepOut = Array.from(
				{ length: 20 },
				(_, i) => `src/long/path/module.ts:${i + 1}: disabledTest(${i});`,
			).join("\n");
			const res = await harness.emitToolResult({
				toolName: "grep",
				toolCallId: "dis-1",
				input: { pattern: "disabledTest" },
				content: [{ type: "text", text: grepOut }],
			});
			assert.equal(res, undefined);
			assert.equal(harness.emitTurnEnd(), undefined);
		} finally {
			if (prev === undefined) delete process.env.RTK_DISABLED;
			else process.env.RTK_DISABLED = prev;
		}
	});

	it("deduplicates warning toasts per failure kind, resets on session_start, and caches recall verification per session", async () => {
		const dir = await makeTempDir("rtk-ext-path-");
		const sessionDir = join(dir, "sessions");
		await mkdir(sessionDir);
		const modeFile = join(dir, "mode.txt");
		const recallCountFile = join(dir, "recalls.txt");
		const storeFile = join(dir, "stored.txt");
		const sampleHash = "abcdef0123456789";

		await createFakeRtk(
			dir,
			`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const args = process.argv.slice(2);
if (mode === "process-fail") {
	process.exit(2);
}
if (mode === "protocol-fail") {
	process.stdout.write("not-json");
	process.exit(0);
}
if (mode === "happy") {
	if (args[0] === "hook") {
		const payload = JSON.parse(readFileSync(0, "utf8"));
		const orig = payload.tool_response.content[0].text;
		writeFileSync(${JSON.stringify(storeFile)}, orig, "utf8");
		const lines = orig.split("\\n");
		const lastLine = lines[lines.length - 1] ?? "done";
		const filtered = "condensed output\\n" + lastLine + "\\n[full output: rtk recall ${sampleHash}]";
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				updatedToolOutput: { content: [{ type: "text", text: filtered }] },
			},
		}));
	} else if (args[0] === "recall") {
		const prev = existsSync(${JSON.stringify(recallCountFile)})
			? Number(readFileSync(${JSON.stringify(recallCountFile)}, "utf8"))
			: 0;
		writeFileSync(${JSON.stringify(recallCountFile)}, String(prev + 1), "utf8");
		process.stdout.write(readFileSync(${JSON.stringify(storeFile)}, "utf8"));
	}
}
`,
		);

		const prevPath = process.env.PATH;
		process.env.PATH = `${dir}:${prevPath ?? ""}`;
		try {
			const harness = createExtensionHarness({ sessionDir });
			const noisyTerminal = `${"\u001b[32mnoisy build line\u001b[0m\n".repeat(40)}build finished`;

			// Two process failures -> only ONE warning toast
			await writeFile(modeFile, "process-fail", "utf8");
			await harness.emitToolResult({
				toolName: "bash",
				toolCallId: "b1",
				input: { command: "make build" },
				content: [{ type: "text", text: noisyTerminal }],
			});
			await harness.emitToolResult({
				toolName: "bash",
				toolCallId: "b2",
				input: { command: "make build" },
				content: [{ type: "text", text: noisyTerminal }],
			});
			assert.equal(harness.notifications.length, 1);
			assert.match(
				harness.notifications[0]?.message ?? "",
				/the RTK process failed/,
			);

			// Distinct failure kind (protocol) -> emits a second toast
			await writeFile(modeFile, "protocol-fail", "utf8");
			await harness.emitToolResult({
				toolName: "bash",
				toolCallId: "b3",
				input: { command: "make build" },
				content: [{ type: "text", text: noisyTerminal }],
			});
			assert.equal(harness.notifications.length, 2);
			assert.match(
				harness.notifications[1]?.message ?? "",
				/unsupported response/,
			);

			// session_start clears reported warnings AND resets recallVerified
			harness.emitSessionStart();
			await writeFile(modeFile, "process-fail", "utf8");
			await harness.emitToolResult({
				toolName: "bash",
				toolCallId: "b4",
				input: { command: "make build" },
				content: [{ type: "text", text: noisyTerminal }],
			});
			assert.equal(harness.notifications.length, 3);

			// Happy mode: 1st call verifies recall (count -> 1), 2nd call skips recall (count stays 1)
			await writeFile(modeFile, "happy", "utf8");
			const ok1 = await harness.emitToolResult({
				toolName: "bash",
				toolCallId: "b5",
				input: { command: "make build" },
				content: [{ type: "text", text: noisyTerminal }],
			});
			assert.ok(ok1?.content);
			assert.equal(await readFile(recallCountFile, "utf8"), "1");

			const ok2 = await harness.emitToolResult({
				toolName: "bash",
				toolCallId: "b6",
				input: { command: "make build" },
				content: [{ type: "text", text: `${noisyTerminal} 2` }],
			});
			assert.ok(ok2?.content);
			assert.equal(await readFile(recallCountFile, "utf8"), "1");
		} finally {
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
		}
	});

	it("/rtk-coverage handles happy path, invalid args, POSIX ENOENT short-circuit (<= 8 spawns), and abort suppression", async () => {
		const root = await makeTempDir("rtk-ext-cov-");
		const sessionDir = join(root, "proj");
		await mkdir(sessionDir);

		const now = Date.now();
		const lines: string[] = [];
		// 40 distinct bash commands in session JSONL
		for (let i = 0; i < 40; i++) {
			lines.push(
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: `call-${i}`,
								name: "bash",
								arguments: { command: `customcmd-${i} --flag` },
							},
						],
					},
				}),
			);
			lines.push(
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: `call-${i}`,
						toolName: "bash",
						timestamp: now,
						content: [{ type: "text", text: `output-${i} ${"x".repeat(40)}` }],
					},
				}),
			);
		}
		await writeFile(join(sessionDir, "s1.jsonl"), `${lines.join("\n")}\n`, "utf8");

		const harness = createExtensionHarness({ sessionDir });

		// 1. Invalid args -> error notify
		await harness.runCoverage("999");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0]?.level, "error");
		harness.notifications.length = 0;

		// 2. Happy path: rewrite returns rewritten for even commands, unchanged for odd
		harness.setExec(async (_cmd, args) => {
			const command = args[2] ?? "";
			const idx = Number(/customcmd-(\d+)/.exec(command)?.[1] ?? "-1");
			if (idx % 2 === 0) {
				return { stdout: `rtk ${command}\n`, stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		await harness.runCoverage("7 project");
		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0]?.level, "info");
		assert.match(harness.notifications[0]?.message ?? "", /rewritten.*20 results/);
		assert.match(
			harness.notifications[0]?.message ?? "",
			/not rewritten.*20 results/,
		);
		harness.notifications.length = 0;

		// 3. POSIX missing-rtk (`spawn rtk ENOENT`) short-circuit: <= 8 spawns, all 40 unclassified
		let enoentSpawns = 0;
		harness.setExec(async () => {
			enoentSpawns++;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return {
				stdout: "",
				stderr: "spawn rtk ENOENT",
				code: 1,
				killed: false,
			};
		});
		await harness.runCoverage("7");
		assert.ok(
			enoentSpawns <= 8,
			`expected <= 8 spawns after ENOENT short-circuit, got ${enoentSpawns}`,
		);
		assert.equal(harness.notifications.length, 1);
		const enoentReport = harness.notifications[0]?.message ?? "";
		assert.match(enoentReport, /unclassified.*40 results/);
		assert.match(enoentReport, /rewritten.*0 results/);
		assert.match(enoentReport, /not rewritten.*0 results/);
		harness.notifications.length = 0;

		// 4. session_shutdown abort suppresses post-abort notify
		const releases1: Array<() => void> = [];
		let observedAbort1 = false;
		let execStartedResolve: (() => void) | undefined;
		const execStarted = new Promise<void>((resolve) => {
			execStartedResolve = resolve;
		});
		harness.setExec(
			(_cmd, _args, opts) =>
				new Promise<ExecResult>((resolve) => {
					execStartedResolve?.();
					const done = (): void => {
						if (opts?.signal?.aborted) observedAbort1 = true;
						resolve({
							stdout: "rtk ok",
							stderr: "",
							code: 0,
							killed: Boolean(opts?.signal?.aborted),
						});
					};
					releases1.push(done);
					opts?.signal?.addEventListener("abort", done, { once: true });
				}),
		);
		const inFlightShutdown = harness.runCoverage("7");
		await execStarted;
		await harness.emitSessionShutdown();
		for (const release of releases1) release();
		await inFlightShutdown;
		assert.equal(observedAbort1, true);
		assert.equal(
			harness.notifications.length,
			0,
			"expected no notify after session_shutdown abort",
		);

		// 5. session_start abort also suppresses post-abort notify
		harness.emitSessionStart();
		const releases2: Array<() => void> = [];
		let observedAbort2 = false;
		let execStartedResolve2: (() => void) | undefined;
		const execStarted2 = new Promise<void>((resolve) => {
			execStartedResolve2 = resolve;
		});
		harness.setExec(
			(_cmd, _args, opts) =>
				new Promise<ExecResult>((resolve) => {
					execStartedResolve2?.();
					const done = (): void => {
						if (opts?.signal?.aborted) observedAbort2 = true;
						resolve({
							stdout: "rtk ok",
							stderr: "",
							code: 0,
							killed: Boolean(opts?.signal?.aborted),
						});
					};
					releases2.push(done);
					opts?.signal?.addEventListener("abort", done, { once: true });
				}),
		);
		const inFlightRestart = harness.runCoverage("7");
		await execStarted2;
		harness.emitSessionStart();
		for (const release of releases2) release();
		await inFlightRestart;
		assert.equal(observedAbort2, true);
		assert.equal(
			harness.notifications.length,
			0,
			"expected no notify after session_start abort",
		);
	});
});
