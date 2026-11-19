import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	compactJsonDocument,
	factorSuffixes,
	groupGrep,
	unfactorSuffixes,
} from "../compact.ts";
import rtkPiExtended from "../index.ts";
import { ENTRY_TYPE, parseEntry } from "../outcomes.ts";

const RECALL_HINT = /\n\[full output: rtk recall ([a-f0-9]{16})\]$/;

// Each test gets its own home, so RTK tracking and recall never touch real data.
function isolate(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "rtk-pi-extended-"));
	const saved = { ...process.env };
	Object.assign(process.env, {
		HOME: home,
		XDG_DATA_HOME: join(home, "data"),
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_CACHE_HOME: join(home, "cache"),
	});
	delete process.env.RTK_DISABLED;
	t.after(() => {
		for (const key of Object.keys(process.env))
			if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(home, { recursive: true, force: true });
	});
	return home;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(exec?: ExtensionAPI["exec"]) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	// Only the API members this extension uses are needed.
	const pi: Pick<ExtensionAPI, "on" | "registerCommand" | "exec"> = {
		on(event: string, handler: Handler) {
			assert.ok(!handlers.has(event), `duplicate ${event} handler`);
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerCommand(name, options) {
			commands.set(name, options.handler);
		},
		exec: exec ?? (async () => assert.fail("unexpected exec")),
	} as Pick<ExtensionAPI, "on" | "registerCommand" | "exec">;
	rtkPiExtended(pi as ExtensionAPI);
	return { handlers, commands };
}

interface ResultMessage {
	role: "toolResult";
	toolCallId: string;
	content: { type: "text"; text: string }[];
}

/** `messages` stands in for the model-visible session projection. */
function context(cwd: string) {
	const notices: { message: string; level: string }[] = [];
	const messages: ResultMessage[] = [];
	let edits = 0;
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, level: string) {
				notices.push({ message, level });
			},
		},
		sessionManager: {
			getLeafId: () => `leaf-${messages.length}-${edits}`,
			buildSessionProjection: () => ({ messages }),
		},
	} as unknown as ExtensionContext;
	/** Drop every earlier result from the projection, as compaction does. */
	const compact = () => {
		messages.length = 0;
		edits++;
	};
	return { ctx, notices, messages, compact };
}

/** Run one result and persist the text Pi would keep. */
async function deliver(
	handlers: Map<string, Handler>,
	session: ReturnType<typeof context>,
	event: ToolResultEvent,
): Promise<string> {
	const result = await run(handlers, event, session.ctx);
	const block = result?.content?.[0] ?? event.content[0];
	const text = block?.type === "text" ? block.text : "";
	session.messages.push({
		role: "toolResult",
		toolCallId: event.toolCallId,
		content: [{ type: "text", text }],
	});
	return text;
}

function tallyKeys(handlers: Map<string, Handler>) {
	const totals: Record<string, number> = {};
	for (const tally of parseEntry(turnEnd(handlers)?.entries[0]?.data)
		?.tallies ?? []) {
		const key = [tally.tool, tally.mechanism, tally.outcome].join(" ");
		totals[key] = (totals[key] ?? 0) + tally.count;
	}
	return totals;
}

function toolResult(
	toolName: string,
	text: string,
	extra: Partial<ToolResultEvent> = {},
) {
	return {
		type: "tool_result",
		toolName,
		toolCallId: "call-1",
		input: {},
		content: [{ type: "text", text }],
		details: undefined,
		isError: false,
		...extra,
	} as ToolResultEvent;
}

async function run(
	handlers: Map<string, Handler>,
	event: ToolResultEvent,
	ctx: ExtensionContext,
) {
	const handler = handlers.get("tool_result");
	assert.ok(handler);
	return (await handler(event, ctx)) as ToolResultEventResult | undefined;
}

function turnEnd(handlers: Map<string, Handler>) {
	const handler = handlers.get("turn_end");
	assert.ok(handler);
	return handler(
		{ type: "turn_end", entries: [] } as unknown as TurnEndEvent,
		{},
	) as
		| { entries: { type: string; customType: string; data: unknown }[] }
		| undefined;
}

function recall(text: string): string {
	const hash = RECALL_HINT.exec(text)?.[1];
	assert.ok(hash, "filtered output ends with a native recall hint");
	const result = spawnSync("rtk", ["recall", hash, "--full"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	return result.stdout;
}

const lines = (count: number, make: (i: number) => string) =>
	Array.from({ length: count }, (_, i) => make(i)).join("\n");

test("compresses raw bash output and keeps the status, notice, and full result", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx, notices } = context(home);
	const notice =
		"[Showing lines 1-2000 of 4000. Full output: /tmp/pi-bash-test.log]";
	const original = [
		"\u001b[32mbuild started\u001b[0m",
		"fetch 10%\rfetch 60%\rfetch 100%",
		lines(20, () => "warning: deprecated option"),
		lines(400, (i) => `step ${i}: compiled module ${i}`),
		"",
		notice,
		"",
		"Command exited with code 1",
	].join("\n");
	const structuredContent = { output: "complete output", exit_code: 1 };
	const result = await run(
		handlers,
		toolResult("bash", original, {
			input: { command: "python3 build.py" },
			isError: true,
			structuredContent,
		} as Partial<ToolResultEvent>),
		ctx,
	);
	const block = result?.content?.[0];
	assert.ok(block?.type === "text");
	const text = block.text;
	// 408 lines after progress and dedup: `cap` keeps the first 50 and the last 200.
	assert.ok(
		text.startsWith(
			"build started\nfetch 100%\nwarning: deprecated option\n[x20]\nstep 0: ",
		),
	);
	assert.ok(
		text.includes(
			"\nstep 45: compiled module 45\n[158 lines elided]\nstep 204: ",
		),
	);
	assert.ok(Buffer.byteLength(text) < Buffer.byteLength(original) * 0.6);
	assert.ok(text.includes(`\n${notice}\n`));
	assert.ok(
		text.replace(RECALL_HINT, "").endsWith("\n\nCommand exited with code 1"),
	);
	assert.equal(recall(text), original);
	// Details, usage, and error state are omitted so Pi keeps its own values.
	assert.deepEqual(Object.keys(result ?? {}).sort(), [
		"content",
		"structuredContent",
	]);
	assert.equal(result?.structuredContent, structuredContent);
	assert.deepEqual(notices, []);

	const entry = turnEnd(handlers)?.entries[0];
	assert.equal(entry?.customType, ENTRY_TYPE);
	assert.deepEqual(parseEntry(entry?.data)?.tallies, [
		{
			tool: "bash",
			category: "terminal",
			mechanism: "rtk:terminal",
			outcome: "filtered",
			count: 1,
			bytesBefore: Buffer.byteLength(original),
			bytesAfter: Buffer.byteLength(text),
		},
	]);
	assert.equal(turnEnd(handlers), undefined);
});

test("leaves RTK-filtered commands, file tools, nested calls, and small results alone", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx } = context(home);
	const long = lines(400, (i) => `row ${i}`);
	const untouched = [
		toolResult("bash", long, { input: { command: "cd app && rtk git diff" } }),
		toolResult("read", long),
		toolResult("edit", long),
		toolResult("bash", long, {
			input: { command: "ls" },
			parentToolCallId: "script",
		}),
		toolResult("bash", "short output", { input: { command: "ls" } }),
	];
	for (const event of untouched)
		assert.equal(await run(handlers, event, ctx), undefined);
	assert.equal(turnEnd(handlers), undefined);
});

test("windows long native grep output and keeps its limit notice", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx } = context(home);
	const original = `${lines(400, (i) => `src/file${i % 7}.ts:${i}: const value${i} = compute(${i});`)}\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]`;
	const result = await run(handlers, toolResult("grep", original), ctx);
	const block = result?.content?.[0];
	assert.ok(block?.type === "text");
	assert.ok(block.text.length < original.length);
	assert.ok(
		block.text
			.replace(RECALL_HINT, "")
			.endsWith(
				"\n[100 matches limit reached. Use limit=200 for more, or refine pattern]",
			),
	);
	assert.equal(recall(block.text), original);
});

test("keeps FFF-shaped output whose headings the window would drop", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx, notices } = context(home);
	const group = (file: string) =>
		[
			file,
			...Array.from({ length: 100 }, (_, i) => ` ${i + 1}: match in ${file}`),
		].join("\n");
	const original = ["a.ts", "b.ts", "c.ts", "d.ts"].map(group).join("\n\n");
	// FFF registers `ffgrep`, or Pi's native names in override mode.
	for (const tool of ["ffgrep", "grep", "multi_grep"])
		assert.equal(
			await run(handlers, toolResult(tool, original), ctx),
			undefined,
			tool,
		);
	assert.equal(
		notices.length,
		1,
		"each failure category warns once per session",
	);
	assert.match(
		notices[0]?.message ?? "",
		/file heading, Pi notice, or final status line/,
	);
	assert.equal(notices[0]?.level, "warning");
	const tallies = parseEntry(turnEnd(handlers)?.entries[0]?.data)?.tallies;
	assert.deepEqual(
		tallies?.map((item) => [item.tool, item.outcome, item.reason, item.count]),
		[
			["ffgrep", "failed", "boundaries", 1],
			["grep", "failed", "boundaries", 1],
			["multi_grep", "failed", "boundaries", 1],
		],
	);
});

test("windows long ffgrep output and keeps its heading, cursor, and recall", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx } = context(home);
	const cursor = '[Continue with cursor="fff_c1"]';
	const original = [
		"src/big.ts",
		...Array.from(
			{ length: 400 },
			(_, i) => ` ${i + 1}: const value${i} = compute(${i});`,
		),
		"",
		cursor,
	].join("\n");
	const result = await run(handlers, toolResult("ffgrep", original), ctx);
	const block = result?.content?.[0];
	assert.ok(block?.type === "text");
	assert.ok(
		block.text.startsWith("src/big.ts\n 1: const value0 = compute(0);\n"),
	);
	assert.match(block.text, /\n\[\d+ lines elided\]\n/);
	assert.ok(block.text.replace(RECALL_HINT, "").endsWith(`\n\n${cursor}`));
	assert.equal(recall(block.text), original);
	// FFF output is already grouped, so only RTK's window applies.
	assert.deepEqual(
		parseEntry(turnEnd(handlers)?.entries[0]?.data)?.tallies.map((item) => [
			item.tool,
			item.mechanism,
			item.outcome,
		]),
		[["ffgrep", "rtk:listing", "filtered"]],
	);
});

test("elides base64 blobs in MCP results without truncating their text", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx } = context(home);
	// Real base64 mixes cases and digits; RTK leaves other long runs alone.
	const png = Buffer.from(
		Array.from({ length: 4500 }, (_, i) => (i * 7919 + 13) % 256),
	).toString("base64");
	const original = JSON.stringify(
		{
			screenshot: `data:image/png;base64,${png}`,
			digest: "0".repeat(1200),
			title: "Example",
			links: lines(50, (i) => `link ${i}`),
		},
		null,
		2,
	);
	const result = await run(
		handlers,
		toolResult("mcp__firecrawl__scrape", original),
		ctx,
	);
	const block = result?.content?.[0];
	assert.ok(block?.type === "text");
	assert.ok(
		block.text.includes('"screenshot": "[base64 image/png, 4 KB elided]"'),
	);
	assert.ok(block.text.includes(`"digest": "${"0".repeat(1200)}"`));
	assert.ok(block.text.includes('"title": "Example"'));
	assert.ok(block.text.includes("link 49"));
	assert.equal(recall(block.text), original);
	// Long curated output is not windowed by default.
	const prose = lines(400, (i) => `paragraph ${i}`);
	assert.equal(
		await run(handlers, toolResult("mcp__x__read_page", prose), ctx),
		undefined,
	);
	assert.deepEqual(
		parseEntry(turnEnd(handlers)?.entries[0]?.data)?.tallies.map((item) => [
			item.tool,
			item.outcome,
		]),
		[
			["mcp__firecrawl__scrape", "filtered"],
			["mcp__x__read_page", "unchanged"],
		],
	);
});

test("honors RTK_DISABLED and cancelled turns without starting RTK", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx } = context(home);
	const event = toolResult(
		"bash",
		lines(400, (i) => `row ${i}`),
		{ input: { command: "make" } },
	);
	process.env.RTK_DISABLED = "1";
	assert.equal(await run(handlers, event, ctx), undefined);
	delete process.env.RTK_DISABLED;
	const cancelled = { ...ctx, signal: AbortSignal.abort() } as ExtensionContext;
	assert.equal(await run(handlers, event, cancelled), undefined);
	assert.equal(turnEnd(handlers), undefined);
});

test("keeps the original and warns once when rtk is unavailable", async (t) => {
	const home = isolate(t);
	const empty = join(home, "empty-bin");
	mkdirSync(empty);
	process.env.PATH = empty;
	const { handlers } = load();
	const { ctx, notices } = context(home);
	const event = toolResult(
		"bash",
		lines(400, (i) => `row ${i}`),
		{ input: { command: "make" } },
	);
	assert.equal(await run(handlers, event, ctx), undefined);
	assert.equal(await run(handlers, event, ctx), undefined);
	assert.deepEqual(notices, [
		{
			message:
				"[rtk-pi-extended] rtk was not found in PATH; original output retained.",
			level: "warning",
		},
	]);
	assert.deepEqual(
		parseEntry(turnEnd(handlers)?.entries[0]?.data)?.tallies.map((item) => [
			item.outcome,
			item.reason,
			item.count,
		]),
		[["failed", "unavailable", 2]],
	);
});

test("/rtk-coverage reports session usage and rejects bad arguments", async (t) => {
	const home = isolate(t);
	const sessionDir = join(home, "sessions", "--project--");
	mkdirSync(sessionDir, { recursive: true });
	const now = Date.now();
	writeFileSync(
		join(sessionDir, "s.jsonl"),
		[
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "a",
							name: "bash",
							arguments: { command: "python3 x.py" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "a",
					toolName: "bash",
					content: [{ type: "text", text: "y".repeat(2048) }],
					timestamp: now,
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	const asked: string[][] = [];
	const { commands } = load(async (command, args) => {
		asked.push([command, ...args]);
		return { stdout: "", stderr: "", code: 1, killed: false, truncated: false };
	});
	const handler = commands.get("rtk-coverage");
	assert.ok(handler);
	const { ctx, notices } = context(home);
	const commandCtx = {
		...ctx,
		sessionManager: { getSessionDir: () => sessionDir },
	} as unknown as ExtensionCommandContext;
	await handler("7", commandCtx);
	assert.deepEqual(asked, [["rtk", "rewrite", "python3 x.py"]]);
	assert.equal(notices[0]?.level, "info");
	const report = notices[0]?.message.split("\n") ?? [];
	assert.equal(
		report[0],
		"RTK coverage, last 7 days, this project (1 session files)",
	);
	assert.ok(report.includes("  largest not rewritten: python3 2.0 KB (1)"));
	await handler("forever", commandCtx);
	assert.deepEqual(notices[1], {
		message:
			'Unsupported argument "forever". Usage: /rtk-coverage [days 1-365] [project|all]',
		level: "error",
	});
});

const SOURCE = lines(400, (i) => `export const value${i} = compute(${i});`);
const slice = (text: string, from: number, to?: number) =>
	text
		.split("\n")
		.slice(from - 1, to)
		.join("\n");

test("replaces repeated reads with stubs, forces exact re-reads, and forgets edited files", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const session = context(home);
	const read = (
		id: string,
		text: string,
		input: Record<string, unknown> = {},
	) =>
		deliver(
			handlers,
			session,
			toolResult("read", text, {
				toolCallId: id,
				input: { path: "src/a.ts", ...input },
			}),
		);
	const unchanged = (range: string, call: string) =>
		`[rtk-pi-extended] Unchanged: lines ${range} of src/a.ts are identical to the read result of tool call ${call}, which is still in this conversation. Use that text, including for edit. Read the same path and offset again to receive it here.`;

	assert.equal(await read("r1", SOURCE), SOURCE);
	assert.equal(await read("r2", SOURCE), unchanged("1-400", "r1"));
	// Reading a replaced range again returns the exact text.
	assert.equal(await read("r3", SOURCE), SOURCE);
	const notice = "[200 more lines in file. Use offset=201 to continue.]";
	assert.equal(
		await read("r4", `${slice(SOURCE, 101, 200)}\n\n${notice}`, {
			offset: 101,
			limit: 100,
		}),
		`${unchanged("101-200", "r3")}\n\n${notice}`,
	);
	// Overlapping ranges: shared lines become a marker, new lines stay verbatim.
	const grown = lines(50, (i) => `export const extra${i} = ${i};`);
	assert.equal(
		await read("r5", `${slice(SOURCE, 301)}\n${grown}`, { offset: 301 }),
		[
			"[rtk-pi-extended] Partly unchanged: lines 301-450 of src/a.ts follow, except lines 301-400, which are identical to the read result of tool call r3 that is still in this conversation. All other lines are verbatim; marker lines are not file text. Read the same path and offset again to receive every line here.",
			"[rtk-pi-extended: lines 301-400 omitted, see tool call r3]",
			grown,
		].join("\n"),
	);

	// A successful edit forgets the file, even when the text happens to match.
	await run(
		handlers,
		toolResult("edit", "Successfully replaced 1 block(s) in src/a.ts.", {
			input: { path: "src/a.ts" },
		}),
		session.ctx,
	);
	assert.equal(await read("r6", SOURCE), SOURCE);
	// Results the model no longer sees, for example after compaction, are never referenced.
	session.compact();
	assert.equal(await read("r7", SOURCE), SOURCE);

	// Verbatim lines before and after a shared range.
	const readB = (id: string, text: string, input: Record<string, unknown>) =>
		deliver(
			handlers,
			session,
			toolResult("read", text, {
				toolCallId: id,
				input: { path: "src/b.ts", ...input },
			}),
		);
	assert.equal(
		await readB("b1", slice(SOURCE, 201, 300), { offset: 201, limit: 100 }),
		slice(SOURCE, 201, 300),
	);
	assert.equal(
		await readB("b2", slice(SOURCE, 151, 350), { offset: 151, limit: 200 }),
		[
			"[rtk-pi-extended] Partly unchanged: lines 151-350 of src/b.ts follow, except lines 201-300, which are identical to the read result of tool call b1 that is still in this conversation. All other lines are verbatim; marker lines are not file text. Read the same path and offset again to receive every line here.",
			slice(SOURCE, 151, 200),
			"[rtk-pi-extended: lines 201-300 omitted, see tool call b1]",
			slice(SOURCE, 301, 350),
		].join("\n"),
	);
	assert.deepEqual(tallyKeys(handlers), {
		"read none unchanged": 4,
		"read read-dedup filtered": 4,
		"read read-forced unchanged": 1,
	});
});

function packageLock(count: number): string {
	const entries = Array.from({ length: count }, (_, i) =>
		[
			`    "node_modules/pkg${i}": {`,
			`      "version": "1.${i}.0",`,
			`      "resolved": "https://registry.npmjs.org/pkg${i}/-/pkg${i}-1.${i}.0.tgz",`,
			`      "integrity": "sha512-${"A".repeat(40)}"`,
			"    },",
		].join("\n"),
	);
	return [
		"{",
		'  "name": "app",',
		'  "lockfileVersion": 3,',
		'  "packages": {',
		...entries,
		"  }",
		"}",
	].join("\n");
}

test("condenses lockfiles and minified files with an exact re-read, and keeps code exact", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const session = context(home);
	const lock = packageLock(100);
	const names = Array.from({ length: 100 }, (_, i) => `pkg${i}@1.${i}.0`).join(
		"\n",
	);
	const summary =
		"Lockfile summary (100 name@version entries; hashes, URLs, and dependency maps omitted) of";
	const caveat =
		"This is not the file's literal text; do not copy it into edit.";

	// A Bash view keeps Pi's truncation notice and points at the read tool.
	const bashNotice =
		"[Showing lines 1-506 of 9000. Full output: /tmp/pi-bash-lock.log]";
	assert.equal(
		await deliver(
			handlers,
			session,
			toolResult("bash", `${lock}\n\n${bashNotice}`, {
				toolCallId: "b1",
				input: { command: "cat package-lock.json" },
			}),
		),
		`[rtk-pi-extended] ${summary} package-lock.json. ${caveat} Read the file with the read tool for the exact text.\n${names}\n\n${bashNotice}`,
	);
	// After a Bash view, a read of any range returns the exact text.
	const tail = slice(lock, 400);
	const readLock = (
		id: string,
		text: string,
		input: Record<string, unknown> = {},
	) =>
		deliver(
			handlers,
			session,
			toolResult("read", text, {
				toolCallId: id,
				input: { path: "package-lock.json", ...input },
			}),
		);
	assert.equal(await readLock("l1", tail, { offset: 400 }), tail);
	// The summary beats a partial stub that would still carry 399 lockfile lines.
	const readNotice =
		"[Showing lines 1-506 of 9000. Use offset=507 to continue.]";
	assert.equal(
		await readLock("l2", `${lock}\n\n${readNotice}`),
		`[rtk-pi-extended] ${summary} lines 1-506 of package-lock.json. ${caveat} Read the same path and offset again for the exact text.\n${names}\n\n${readNotice}`,
	);
	assert.equal(
		await readLock("l3", `${lock}\n\n${readNotice}`),
		`${lock}\n\n${readNotice}`,
	);

	const bundle = `!function(){${"var a=1;".repeat(700)}}();\n//# sourceMappingURL=app.min.js.map`;
	const trimmed = await deliver(
		handlers,
		session,
		toolResult("read", bundle, {
			toolCallId: "m1",
			input: { path: "dist/app.min.js" },
		}),
	);
	assert.equal(
		trimmed,
		`[rtk-pi-extended] Lines over 300 characters trimmed in lines 1-2 of dist/app.min.js. ${caveat} Read the same path and offset again for the exact text.\n${bundle.slice(0, 300)}…[+5316 chars]\n//# sourceMappingURL=app.min.js.map`,
	);

	// Code and Markdown views are never transformed, whatever printed them.
	const code = lines(200, (i) => `\t// comment ${i}\n\n\treturn value${i};`);
	for (const event of [
		toolResult("bash", code, {
			toolCallId: "c1",
			input: { command: "cat src/big.ts" },
		}),
		toolResult("bash", code, {
			toolCallId: "c2",
			input: { command: "sed -n '1,600p' src/big.ts" },
		}),
		toolResult("read", code, {
			toolCallId: "c3",
			input: { path: "src/big.ts" },
		}),
		toolResult("read", code, {
			toolCallId: "c4",
			input: { path: "README.md" },
		}),
	])
		assert.equal(await deliver(handlers, session, event), code);
	assert.deepEqual(tallyKeys(handlers), {
		"bash lockfile-summary filtered": 1,
		"bash none unchanged": 2,
		"read lockfile-summary filtered": 1,
		"read long-line-trim filtered": 1,
		"read none unchanged": 2,
		"read read-forced unchanged": 2,
	});
});

test("removes JSON indentation only from large excerpts Pi truncated", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const session = context(home);
	const document = (count: number) =>
		JSON.stringify(
			{
				items: Array.from({ length: count }, (_, i) => ({
					id: i,
					name: `item ${i}`,
					tags: ["alpha", "beta"],
				})),
			},
			null,
			2,
		);
	const large = document(300);
	assert.ok(Buffer.byteLength(large) > 16 * 1024);
	const notice = "[Showing lines 1-2000 of 9000. Use offset=2001 to continue.]";
	const read = (path: string, text: string) =>
		deliver(
			handlers,
			session,
			toolResult("read", text, { toolCallId: path, input: { path } }),
		);
	// A complete file is usually read in order to edit it.
	assert.equal(await read("data/full.json", large), large);
	assert.equal(
		await read("data/small.json", `${document(40)}\n\n${notice}`),
		`${document(40)}\n\n${notice}`,
	);
	assert.equal(
		await read("data/part.json", `${large}\n\n${notice}`),
		`[rtk-pi-extended] JSON with indentation removed, lines 1-${large.split("\n").length} of data/part.json. This is not the file's literal text; do not copy it into edit. Read the same path and offset again for the exact text.\n${large.replace(/^[ \t]+/gm, "")}\n\n${notice}`,
	);
});

test("filters RTK-wrapped commands only when RTK passed raw terminal output through", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx } = context(home);
	const plain = lines(400, (i) => `ok ${i} - test ${i}`);
	assert.equal(
		await run(
			handlers,
			toolResult("bash", plain, { input: { command: "rtk bun test" } }),
			ctx,
		),
		undefined,
	);
	const colored = lines(400, (i) => `\u001b[32m✓\u001b[0m test ${i}`);
	const result = await run(
		handlers,
		toolResult("bash", colored, { input: { command: "rtk bun test" } }),
		ctx,
	);
	const block = result?.content?.[0];
	assert.ok(block?.type === "text");
	assert.ok(!block.text.includes("\u001b"));
	assert.equal(recall(block.text), colored);
});

/** Puts a logging wrapper around the real `rtk` first in PATH. */
function countingRtk(home: string): () => string[] {
	const real = spawnSync("sh", ["-c", "command -v rtk"], {
		encoding: "utf8",
	}).stdout.trim();
	assert.ok(real, "rtk is installed");
	const bin = join(home, "shim");
	const log = join(home, "spawns.log");
	mkdirSync(bin);
	writeFileSync(log, "");
	writeFileSync(
		join(bin, "rtk"),
		`#!/bin/sh\necho "$1" >> '${log}'\nexec '${real}' "$@"\n`,
	);
	chmodSync(join(bin, "rtk"), 0o755);
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	return () => readFileSync(log, "utf8").split("\n").filter(Boolean);
}

test("starts RTK only when a method could change the output, and reads recall back once", async (t) => {
	const home = isolate(t);
	const spawns = countingRtk(home);
	const { handlers } = load();
	const session = context(home);
	const terse = lines(60, (i) => ` M src/file${i}.ts`);
	assert.equal(
		await run(
			handlers,
			toolResult("bash", terse, {
				input: { command: "git status --porcelain" },
			}),
			session.ctx,
		),
		undefined,
	);
	const grep = `${lines(120, (i) => `src/module${Math.floor(i / 10)}/file.ts:${i + 1}: const value = compute(${i});`)}\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]`;
	assert.equal(
		await deliver(handlers, session, toolResult("grep", grep)),
		groupGrep(grep),
	);
	assert.deepEqual(spawns(), []);

	const colored = (tag: string) =>
		lines(400, (i) => `\u001b[2m${tag} ${i}\u001b[0m`);
	for (const tag of ["first", "second"]) {
		const result = await run(
			handlers,
			toolResult("bash", colored(tag), { input: { command: "make" } }),
			session.ctx,
		);
		assert.match(
			result?.content?.[0]?.type === "text" ? result.content[0].text : "",
			RECALL_HINT,
		);
	}
	assert.deepEqual(spawns(), ["hook", "recall", "hook"]);
	assert.deepEqual(tallyKeys(handlers), {
		"bash gate unchanged": 1,
		"bash rtk:terminal filtered": 2,
		"grep grep-group filtered": 1,
	});
});

test("factors repeated tails, compacts JSON, and omits passages still in context", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const session = context(home);
	const diagnostics = lines(
		30,
		(i) =>
			`src/a.ts:${i + 1}:5 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
	);
	const factored = await deliver(
		handlers,
		session,
		toolResult("lsp_diagnostics", diagnostics, { toolCallId: "d1" }),
	);
	assert.equal(factored, factorSuffixes(diagnostics));
	assert.equal(unfactorSuffixes(factored), diagnostics);

	const payload = JSON.stringify(
		{
			results: Array.from({ length: 20 }, (_, i) => ({
				id: `node-${i}`,
				path: `src/f${i}.ts`,
				score: i,
			})),
		},
		null,
		2,
	);
	const compact = await deliver(
		handlers,
		session,
		toolResult("mcp__portainer__listStacks", payload, { toolCallId: "j1" }),
	);
	assert.equal(compact, compactJsonDocument(payload));
	assert.deepEqual(JSON.parse(compact), JSON.parse(payload));

	const tool = "mcp__codegraph__codegraph_explore";
	const passage = (name: string) =>
		`## ${name}\n${lines(12, (i) => `  function ${name}${i}() { return ${i}; }`)}`;
	const first = [passage("alpha"), passage("beta"), "End of results."].join(
		"\n\n",
	);
	assert.equal(
		await deliver(
			handlers,
			session,
			toolResult(tool, first, { toolCallId: "c1" }),
		),
		first,
	);
	const second = [
		passage("alpha"),
		passage("beta"),
		passage("gamma"),
		"End of results.",
	].join("\n\n");
	const bytes =
		Buffer.byteLength(passage("alpha")) + Buffer.byteLength(passage("beta"));
	assert.equal(
		await deliver(
			handlers,
			session,
			toolResult(tool, second, { toolCallId: "c2" }),
		),
		[
			`[rtk-pi-extended: 2 passage(s), ${bytes} bytes, omitted; identical text is in the ${tool} result of tool call c1 earlier in this conversation]`,
			passage("gamma"),
			"End of results.",
		].join("\n\n"),
	);
	session.compact();
	assert.equal(
		await deliver(
			handlers,
			session,
			toolResult(tool, second, { toolCallId: "c3" }),
		),
		second,
	);
});

test("keeps the original when a change saves too little", async (t) => {
	const home = isolate(t);
	const { handlers } = load();
	const { ctx } = context(home);
	// RTK removes nine bytes of colour codes: under the 128-byte minimum.
	const colored = `${lines(60, (i) => `line ${i} ok`)}\n\u001b[32mdone\u001b[0m`;
	assert.equal(
		await run(
			handlers,
			toolResult("bash", colored, { input: { command: "make" } }),
			ctx,
		),
		undefined,
	);
	// Grouping two files saves about 70 bytes.
	const grep = lines(
		20,
		(i) => `${i < 10 ? "a" : "b"}.ts:${i}: ${"x".repeat(30)}`,
	);
	assert.ok(groupGrep(grep));
	assert.equal(await run(handlers, toolResult("grep", grep), ctx), undefined);
	assert.deepEqual(tallyKeys(handlers), {
		"bash rtk:terminal unchanged": 1,
		"grep grep-group unchanged": 1,
	});
});
