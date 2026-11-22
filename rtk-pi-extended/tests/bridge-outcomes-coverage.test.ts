import assert from "node:assert/strict";
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
	parseCoverageArgs,
	scanSessions,
	sessionFiles,
	type Usage,
} from "../coverage.ts";
import {
	ENTRY_TYPE,
	Ledger,
	mergeTallies,
	parseEntry,
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
	it("preserves FFF file headings in order and rejects dropped/reordered headings or orphan numbered lines", () => {
		const original = [
			"src/alpha.ts",
			" 10: const a = 1;",
			" 11- const b = 2;",
			"",
			"src/beta.ts",
			" 20: export function run() {}",
			"[2 matches in 2 files]",
		].join("\n");
		const valid = [
			"src/alpha.ts",
			" 10: const a = 1;",
			"[... 1 lines elided ...]",
			"src/beta.ts",
			" 20: export function run() {}",
			"[2 matches in 2 files]",
		].join("\n");
		assert.equal(preservesBoundaries(original, valid), true);
		assert.equal(
			preservesBoundaries(original, "src/alpha.ts\n 10: const a = 1;\n 20: x"),
			false,
		);
		assert.equal(
			preservesBoundaries(
				original,
				"src/beta.ts\n 20: x\n\nsrc/alpha.ts\n 10: y",
			),
			false,
		);
		assert.equal(preservesBoundaries(" 10: orphan", " 10: orphan"), false);
		assert.equal(
			preservesBoundaries(
				"[0 exact matches. Maybe you meant this?]\nsrc/a.ts\n 1: hit",
				"[0 exact matches. Maybe you meant this?]\nsrc/a.ts\n 1: hit",
			),
			true,
		);
	});
});

describe("bridge.ts — invokeRtk & filterPosthook", () => {
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

	it("invokes RTK with isolated RTK_CONFIG_DIR and enforces missing/timeout/abort/byte limits", async () => {
		const dir = await makeTempDir("rtk-invoke-");
		const cfgDir = join(dir, "cfg");
		await mkdir(cfgDir);
		const bin = await createFakeRtk(
			dir,
			`
import { readFileSync } from "node:fs";
process.stdout.write(JSON.stringify({
	args: process.argv.slice(2),
	stdin: readFileSync(0, "utf8"),
	rtkConfigDir: process.env.RTK_CONFIG_DIR,
}));
`,
		);

		const okRes = await invokeRtk(["hook", "claude"], "hello", {
			configDirectory: cfgDir,
			executable: bin,
			env: { ...process.env, RTK_CONFIG_DIR: "/overridden" },
		});
		assert.equal(okRes.ok, true);
		if (okRes.ok) {
			const parsed = JSON.parse(okRes.stdout) as {
				args: string[];
				stdin: string;
				rtkConfigDir: string;
			};
			assert.deepEqual(parsed.args, ["hook", "claude"]);
			assert.equal(parsed.stdin, "hello");
			assert.equal(parsed.rtkConfigDir, cfgDir);
		}

		assert.deepEqual(
			await invokeRtk(["hook", "claude"], "hi", {
				configDirectory: cfgDir,
				executable: join(dir, "missing-rtk"),
			}),
			{ ok: false, reason: "unavailable" },
		);

		assert.deepEqual(
			await invokeRtk(["hook", "claude"], "🚀".repeat(10), {
				configDirectory: cfgDir,
				executable: bin,
				maxBytes: 32,
			}),
			{ ok: false, reason: "input-limit" },
		);

		const slowBin = await createFakeRtk(
			await makeTempDir("rtk-slow-"),
			`setTimeout(() => {}, 5_000);`,
		);
		assert.deepEqual(
			await invokeRtk(["hook", "claude"], "hi", {
				configDirectory: cfgDir,
				executable: slowBin,
				timeoutMs: 60,
			}),
			{ ok: false, reason: "timeout" },
		);

		const aborted = new AbortController();
		aborted.abort();
		assert.deepEqual(
			await invokeRtk(["hook", "claude"], "hi", {
				configDirectory: cfgDir,
				executable: slowBin,
				signal: aborted.signal,
			}),
			{ ok: false, reason: "aborted" },
		);
	});

	it("filters PostToolUse output with recall verification and rejects recall/boundary/protocol failures", async () => {
		const dir = await makeTempDir("rtk-posthook-");
		const storeFile = join(dir, "recall.txt");
		const recallCountFile = join(dir, "count.txt");
		const bin = await createFakeRtk(
			dir,
			`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "hook") {
	const payload = JSON.parse(readFileSync(0, "utf8"));
	writeFileSync(${JSON.stringify(storeFile)}, payload.tool_response.content[0].text, "utf8");
	process.stdout.write(${JSON.stringify(makeEnvelope(`short\n[full output: rtk recall ${sampleHash}]`))});
} else if (args[0] === "recall" && args[1] === "${sampleHash}" && args[2] === "--full") {
	const prev = existsSync(${JSON.stringify(recallCountFile)}) ? Number(readFileSync(${JSON.stringify(recallCountFile)}, "utf8")) : 0;
	writeFileSync(${JSON.stringify(recallCountFile)}, String(prev + 1), "utf8");
	process.stdout.write(readFileSync(${JSON.stringify(storeFile)}, "utf8"));
} else {
	process.exit(1);
}
`,
		);

		const original = "line of noisy output\n".repeat(30);
		const filtered = await filterPosthook(
			"pi-bash",
			original,
			{ configDirectory: dir, executable: bin },
			() => true,
			true,
		);
		assert.deepEqual(filtered, {
			kind: "filtered",
			text: `short\n[full output: rtk recall ${sampleHash}]`,
		});
		assert.equal(await readFile(recallCountFile, "utf8"), "1");

		// Force recall even when verifyRecall=false if original embeds obfuscated hash
		const obfuscated = `${original} \u001b[31m01234567\u001b[0m\u200b89abcdef`;
		const forced = await filterPosthook(
			"pi-bash",
			obfuscated,
			{ configDirectory: dir, executable: bin },
			() => true,
			false,
		);
		assert.equal(forced.kind, "filtered");
		assert.equal(await readFile(recallCountFile, "utf8"), "2");

		// Boundary check failure rejects before recall
		const boundaryFail = await filterPosthook(
			"pi-ffgrep",
			"src/a.ts\n 1: a\n\nsrc/b.ts\n 2: b\n" + " 3: pad\n".repeat(20),
			{ configDirectory: dir, executable: bin },
			preservesBoundaries,
			true,
		);
		assert.deepEqual(boundaryFail, { kind: "failed", reason: "boundaries" });
		assert.equal(await readFile(recallCountFile, "utf8"), "2");

		// Recall mismatch -> recovery failure
		const mismatchDir = await makeTempDir("rtk-mismatch-");
		const mismatchBin = await createFakeRtk(
			mismatchDir,
			`
if (process.argv[2] === "hook") {
	process.stdout.write(${JSON.stringify(makeEnvelope(`short\n[full output: rtk recall ${sampleHash}]`))});
} else {
	process.stdout.write("corrupted");
}
`,
		);
		assert.deepEqual(
			await filterPosthook(
				"pi-bash",
				original,
				{ configDirectory: mismatchDir, executable: mismatchBin },
				() => true,
				true,
			),
			{ kind: "failed", reason: "recovery" },
		);
	});
});

describe("outcomes.ts — Ledger, mergeTallies & parseEntry", () => {
	it("aggregates ledger tuples, merges tallies, and validates entry schema", () => {
		const ledger = new Ledger();
		assert.equal(ledger.drain(), undefined);

		ledger.record({
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "filtered",
			bytesBefore: 1000,
			bytesAfter: 300,
		});
		ledger.record({
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "filtered",
			bytesBefore: 2000,
			bytesAfter: 500,
		});
		ledger.record({
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "failed",
			reason: "timeout",
			bytesBefore: 900,
			bytesAfter: 900,
		});

		const drained = ledger.drain();
		assert.ok(drained);
		assert.equal(drained.tallies.length, 2);
		assert.deepEqual(parseEntry(drained), drained);
		assert.equal(ledger.drain(), undefined);

		const map = new Map<string, Tally>();
		for (const t of drained.tallies) mergeTallies(map, t);
		assert.equal(map.size, 2);

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

		for (const bad of [
			null,
			{ version: 2, tallies: drained.tallies },
			{ version: 1, tallies: [] },
			{
				version: 1,
				tallies: [
					{
						tool: "bash",
						category: "terminal",
						mechanism: "rtk:terminal",
						outcome: "filtered",
						count: 1,
						bytesBefore: 500,
						bytesAfter: 500, // filtered must shrink
					},
				],
			},
		]) {
			assert.equal(parseEntry(bad), undefined);
		}
	});
});

describe("coverage.ts — parseCoverageArgs, sessionFiles, scanSessions & classifyBash", () => {
	it("parses /rtk-coverage args and rejects out-of-range or duplicate tokens", () => {
		assert.deepEqual(parseCoverageArgs(""), {
			ok: true,
			options: { days: 30, scope: "project" },
		});
		assert.deepEqual(parseCoverageArgs("all 14"), {
			ok: true,
			options: { days: 14, scope: "all" },
		});
		for (const bad of ["0", "366", "foo", "7 14", "all project"]) {
			assert.equal(parseCoverageArgs(bad).ok, false, bad);
		}
	});

	it("discovers session files safely, scans JSONL entries, and classifies bash commands", async () => {
		const root = await makeTempDir("rtk-cov-");
		const projA = join(root, "proj-a");
		const projB = join(root, "proj-b");
		const ignored = join(projA, "subagent-artifacts");
		await mkdir(ignored, { recursive: true });
		await mkdir(projB, { recursive: true });

		const recentA = join(projA, "recent.jsonl");
		const oldA = join(projA, "old.jsonl");
		const recentB = join(projB, "other.jsonl");
		await writeFile(join(ignored, "dup.jsonl"), "{}\n", "utf8");
		await writeFile(oldA, "{}\n", "utf8");
		await symlink(recentB, join(projA, "linked.jsonl"));

		const now = Date.now();
		const since = now - 2 * 86_400_000;
		const oldSec = (now - 10 * 86_400_000) / 1000;
		await utimes(oldA, oldSec, oldSec);

		await writeFile(
			recentA,
			[
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "c1",
								name: "bash",
								arguments: { command: "git status" },
							},
						],
					},
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "bash",
						timestamp: now,
						content: [{ type: "text", text: "clean" }],
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
								bytesBefore: 1000,
								bytesAfter: 200,
							},
						],
					},
				}),
				"{malformed",
			].join("\n"),
			"utf8",
		);
		await writeFile(recentB, "{}\n", "utf8");

		assert.deepEqual(await sessionFiles(projA, "project", since), [recentA]);
		assert.deepEqual(
			await sessionFiles(projA, "all", since),
			[recentA, recentB].sort(),
		);
		assert.deepEqual(await sessionFiles("", "all", since), []);

		const scan = await scanSessions([recentA], since);
		assert.equal(scan.files, 1);
		assert.equal(scan.unreadableLines, 1);
		assert.deepEqual(scan.bashCommands.get("git status"), {
			results: 1,
			bytes: 5,
		});
		assert.equal(scan.tallies.size, 1);

		const commands = new Map<string, Usage>([
			["git status", { results: 2, bytes: 1000 }],
			["rtk pytest -q", { results: 1, bytes: 2000 }],
			["env -u FOO /usr/bin/python3 script.py", { results: 3, bytes: 1500 }],
			["", { results: 1, bytes: 100 }],
		]);
		const seen: string[] = [];
		const coverage = await classifyBash(commands, async (cmd) => {
			seen.push(cmd);
			return cmd === "git status";
		});
		assert.equal(seen.includes("rtk pytest -q"), false);
		assert.deepEqual(coverage.rewritten, { results: 3, bytes: 3000 });
		assert.deepEqual(coverage.notRewritten, { results: 3, bytes: 1500 });
		assert.deepEqual(coverage.unclassified, { results: 1, bytes: 100 });
		assert.deepEqual(coverage.programs.get("python3"), {
			results: 3,
			bytes: 1500,
		});
	});
});
