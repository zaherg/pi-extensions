import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	classifyBash,
	formatReport,
	parseCoverageArgs,
	scanSessions,
	sessionFiles,
	windowStart,
} from "../coverage.ts";
import { ENTRY_TYPE } from "../outcomes.ts";

test("parses days and scope strictly", () => {
	assert.deepEqual(parseCoverageArgs(""), {
		ok: true,
		options: { days: 30, scope: "project" },
	});
	assert.deepEqual(parseCoverageArgs(" 7  all "), {
		ok: true,
		options: { days: 7, scope: "all" },
	});
	assert.deepEqual(parseCoverageArgs("project 365"), {
		ok: true,
		options: { days: 365, scope: "project" },
	});
	for (const args of [
		"0",
		"366",
		"7 7",
		"all project",
		"-1",
		"7d",
		"1e2",
		"--all",
	])
		assert.equal(parseCoverageArgs(args).ok, false, args);
});

const NOW = Date.UTC(2026, 10, 19);
const SINCE = windowStart(30, NOW);
const RECENT = NOW - 86_400_000;
const OLD = NOW - 40 * 86_400_000;

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const assistant = (...content: unknown[]) => ({
	type: "message",
	message: { role: "assistant", content },
});
const result = (
	id: string,
	toolName: string,
	bytes: number,
	timestamp = RECENT,
) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: "x".repeat(bytes) }],
		isError: false,
		timestamp,
	},
});
const outcome = (data: unknown, time = RECENT) => ({
	type: "custom",
	customType: ENTRY_TYPE,
	data,
	timestamp: new Date(time).toISOString(),
});
const tally = (
	outcome: string,
	count: number,
	before: number,
	after: number,
	reason?: string,
) => ({
	tool: "bash",
	category: "terminal",
	mechanism: "rtk:terminal",
	outcome,
	...(reason ? { reason } : {}),
	count,
	bytesBefore: before,
	bytesAfter: after,
});

function sessionsRoot(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "rtk-coverage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "--project-a--");
	const other = join(root, "--project-b--");
	const subagentDir = join(project, "s1", "run-1", "run-0");
	const artifactsDir = join(project, "subagent-artifacts");
	mkdirSync(subagentDir, { recursive: true });
	mkdirSync(artifactsDir, { recursive: true });
	mkdirSync(other);
	const write = (file: string, entries: unknown[], extra = "") =>
		writeFileSync(
			file,
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n${extra}`,
		);

	write(
		join(project, "one.jsonl"),
		[
			{ type: "session", id: "s1" },
			assistant(
				call("c1", "bash", { command: "python3 report.py" }),
				call("c2", "bash", { command: "git status" }),
				call("c3", "bash", { command: "cd x && rtk git diff" }),
				call("c4", "read", { path: "a.ts" }),
			),
			result("c1", "bash", 3000),
			result("c2", "bash", 1000),
			result("c3", "bash", 500),
			result("c4", "read", 4000),
			result("c9", "bash", 200),
			result("old", "bash", 9000, OLD),
			// Transcript-format records lack `type: "message"` and must be ignored.
			{
				message: {
					role: "toolResult",
					toolCallId: "dup",
					toolName: "grep",
					content: [{ type: "text", text: "x".repeat(9999) }],
					isError: false,
					timestamp: RECENT,
				},
			},
			outcome({
				version: 1,
				tallies: [
					tally("filtered", 2, 6000, 2000),
					tally("unchanged", 1, 700, 700),
					tally("failed", 1, 900, 900, "boundaries"),
				],
			}),
			outcome({ version: 1, tallies: [tally("filtered", 1, 500, 100)] }, OLD),
			outcome({ version: 1, tallies: [{ tool: "bash" }] }),
		],
		"{not json\n",
	);
	const nested = join(subagentDir, "session.jsonl");
	write(nested, [result("s1", "grep", 1200)]);
	const transcript = join(artifactsDir, "run_transcript.jsonl");
	write(transcript, [
		{
			message: {
				role: "toolResult",
				toolCallId: "s1",
				toolName: "grep",
				content: [{ type: "text", text: "x".repeat(1200) }],
				isError: false,
				timestamp: RECENT,
			},
		},
	]);
	write(join(other, "two.jsonl"), [
		assistant(call("d1", "bash", { command: "node build.mjs" })),
		result("d1", "bash", 2000),
		result("m1", "mcp__codegraph__codegraph_explore", 1500),
	]);
	const stale = join(other, "stale.jsonl");
	write(stale, [result("z", "bash", 5000)]);
	utimesSync(stale, OLD / 1000, OLD / 1000);
	symlinkSync(join(project, "one.jsonl"), join(other, "linked.jsonl"));
	symlinkSync(other, join(project, "linked-dir"));
	writeFileSync(join(project, "notes.txt"), "ignored");
	return { root, project, other, nested, transcript };
}

test("selects recent session files, including nested subagents, skipping artifacts and symlinks", async (t) => {
	const { root, project, other, nested } = sessionsRoot(t);
	assert.deepEqual(await sessionFiles(project, "project", SINCE), [
		join(project, "one.jsonl"),
		nested,
	]);
	// A recent mtime on an old file is kept; entry timestamps decide what counts.
	assert.deepEqual(await sessionFiles(project, "all", SINCE), [
		join(project, "one.jsonl"),
		nested,
		join(other, "two.jsonl"),
	]);
	assert.deepEqual(
		await sessionFiles(join(root, "missing"), "project", SINCE),
		[],
	);
});

test("aggregates delivered bytes, bash commands, and outcome entries in the window", async (t) => {
	const { project, other, transcript } = sessionsRoot(t);
	const scan = await scanSessions(
		[join(project, "one.jsonl"), join(other, "two.jsonl"), transcript],
		SINCE,
	);
	assert.equal(scan.files, 3);
	assert.equal(scan.unreadableLines, 1);
	assert.equal(scan.invalidEntries, 1);
	assert.deepEqual(Object.fromEntries(scan.tools), {
		bash: { results: 5, bytes: 6700 },
		read: { results: 1, bytes: 4000 },
		mcp__codegraph__codegraph_explore: { results: 1, bytes: 1500 },
	});
	assert.deepEqual(Object.fromEntries(scan.bashCommands), {
		"python3 report.py": { results: 1, bytes: 3000 },
		"git status": { results: 1, bytes: 1000 },
		"cd x && rtk git diff": { results: 1, bytes: 500 },
		"": { results: 1, bytes: 200 },
		"node build.mjs": { results: 1, bytes: 2000 },
	});
	assert.deepEqual(
		[...scan.tallies.values()].map((item) => [
			item.outcome,
			item.count,
			item.bytesBefore,
			item.bytesAfter,
		]),
		[
			["filtered", 2, 6000, 2000],
			["unchanged", 1, 700, 700],
			["failed", 1, 900, 900],
		],
	);
});

test("classifies bash output by the stock hook's rewrite decision", async () => {
	const asked: string[] = [];
	const answers = new Map<string, boolean | undefined>([
		["python3 report.py", false],
		["SECRET=abc /usr/bin/node build.mjs", false],
		["set -euo pipefail; cd /repo && python3 check.py", false],
		['cd "a;b" && env -u SECRET FOO=1 python3 x.py', false],
		['export MSG="secret; leak" && time npm test', false],
		["cd x &&\\\nnpm run build", false],
		["git status", true],
		["flaky", undefined],
	]);
	const coverage = await classifyBash(
		new Map([
			["python3 report.py", { results: 2, bytes: 3000 }],
			["SECRET=abc /usr/bin/node build.mjs", { results: 1, bytes: 2000 }],
			[
				"set -euo pipefail; cd /repo && python3 check.py",
				{ results: 1, bytes: 1500 },
			],
			[
				'cd "a;b" && env -u SECRET FOO=1 python3 x.py',
				{ results: 1, bytes: 600 },
			],
			[
				'export MSG="secret; leak" && time npm test',
				{ results: 1, bytes: 400 },
			],
			["cd x &&\\\nnpm run build", { results: 1, bytes: 500 }],
			["git status", { results: 1, bytes: 1000 }],
			["cd x && rtk git diff", { results: 1, bytes: 500 }],
			["flaky", { results: 1, bytes: 300 }],
			["", { results: 1, bytes: 200 }],
		]),
		async (command) => {
			asked.push(command);
			return answers.get(command);
		},
	);
	assert.deepEqual(asked.sort(), [
		"SECRET=abc /usr/bin/node build.mjs",
		'cd "a;b" && env -u SECRET FOO=1 python3 x.py',
		"cd x &&\\\nnpm run build",
		'export MSG="secret; leak" && time npm test',
		"flaky",
		"git status",
		"python3 report.py",
		"set -euo pipefail; cd /repo && python3 check.py",
	]);
	assert.deepEqual(coverage.rewritten, { results: 2, bytes: 1500 });
	assert.deepEqual(coverage.notRewritten, { results: 7, bytes: 8000 });
	assert.deepEqual(coverage.unclassified, { results: 2, bytes: 500 });
	// Quoted values, line continuations, setup commands, and wrappers unwrap cleanly.
	assert.deepEqual(Object.fromEntries(coverage.programs), {
		python3: { results: 4, bytes: 5100 },
		node: { results: 1, bytes: 2000 },
		npm: { results: 2, bytes: 900 },
	});
});

test("formats the report from measured values", async (t) => {
	const { project, other } = sessionsRoot(t);
	const scan = await scanSessions(
		[join(project, "one.jsonl"), join(other, "two.jsonl")],
		SINCE,
	);
	const bash = await classifyBash(
		scan.bashCommands,
		async (command) => command === "git status",
	);
	const report = formatReport({ days: 30, scope: "all" }, scan, bash).split(
		"\n",
	);
	assert.equal(
		report[0],
		"RTK coverage, last 30 days, all projects (2 session files)",
	);
	// 12,200 delivered bytes plus 4,000 bytes saved on bash: 16,200 originally.
	assert.deepEqual(report.slice(1, 8), [
		"Tool output: 15.8 KB originally, 11.9 KB delivered, in 7 results",
		"rtk-pi-extended touched 37% of all tool output and removed 67% of what it touched: 3.9 KB, 25% of all tool output.",
		"",
		"By tool        original  share  touched  saved  filter owner",
		"  bash              10.4 KB    66%      56%    37%  rtk rewrite, else terminal",
		"  read               3.9 KB    25%       0%     0%  dedup, non-code views",
		"  mcp__codegraph_…   1.5 KB     9%       0%     0%  generic",
	]);
	assert.ok(report.includes("  rtk:terminal        3.9 KB saved in 2 results"));
	assert.ok(
		report.includes("  not rewritten       4.9 KB       2 results   75%"),
	);
	assert.ok(
		report.includes(
			"  largest not rewritten: python3 2.9 KB (1), node 2.0 KB (1)",
		),
	);
	assert.ok(
		report.includes("  filtered   2 results, 5.9 KB -> 2.0 KB (67% removed)"),
	);
	assert.ok(
		report.includes(
			"  original kept after a failed check  1 results (boundaries 1)",
		),
	);
	assert.ok(
		report.includes(
			"Skipped 1 unreadable session lines and 1 invalid outcome entries.",
		),
	);
});

test("strips terminal controls from tool and program names in the report", async () => {
	const evil = "\u001b]52;c;cHduZWQ=\u0007\u001b[2Jpwn\u001b[0m";
	const bash = await classifyBash(
		new Map([["\u001b[31mpwn\u001b[0m\u0007 --flag", { results: 1, bytes: 2000 }]]),
		async () => false,
	);
	const scan = {
		files: 1,
		unreadableLines: 0,
		invalidEntries: 0,
		tools: new Map([
			["bash", { results: 1, bytes: 2000 }],
			[`tool${evil}`, { results: 1, bytes: 1000 }],
		]),
		bashCommands: new Map(),
		tallies: new Map(),
	};
	const report = formatReport({ days: 7, scope: "project" }, scan, bash);
	// No ESC, BEL, or other C0 control except newlines survives into the notice.
	assert.doesNotMatch(report, /[\u0000-\u0009\u000b-\u001f\u007f]/);
	assert.match(report, /largest not rewritten: pwn 2\.0 KB \(1\)/);
	assert.match(report, /\n {2}toolpwn {9}/);
});
