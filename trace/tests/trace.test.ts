import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import trace, { callPreview, codemodeCalls } from "../index.ts";

interface NotifyRecord {
	message: string;
	level: string | undefined;
}

interface SelectCall {
	title: string;
	options: string[];
	signal: AbortSignal | undefined;
}

type SelectHandler = (
	title: string,
	options: string[],
	opts?: { signal?: AbortSignal },
) => Promise<string | undefined>;

function makeAssistantEntry(
	id: string,
	toolCalls: Array<{
		id: string;
		name: string;
		arguments: Record<string, unknown>;
	}>,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-22T10:00:00Z",
		message: {
			role: "assistant",
			content: toolCalls.map((call) => ({
				type: "toolCall" as const,
				id: call.id,
				name: call.name,
				arguments: call.arguments as ToolCall["arguments"],
			})),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function makeToolResultMessage(opts: {
	toolCallId: string;
	toolName: string;
	text?: string;
	content?: ToolResultMessage["content"];
	details?: unknown;
	isError?: boolean;
}): ToolResultMessage {
	const content: ToolResultMessage["content"] =
		opts.content ??
		(opts.text !== undefined ? [{ type: "text", text: opts.text }] : []);
	return {
		role: "toolResult",
		toolCallId: opts.toolCallId,
		toolName: opts.toolName,
		content,
		...(opts.details !== undefined
			? { details: opts.details as NonNullable<ToolResultMessage["details"]> }
			: {}),
		isError: opts.isError ?? false,
		timestamp: 1,
	};
}

function makeToolResultEntry(opts: {
	id: string;
	timestamp?: string;
	toolCallId: string;
	toolName: string;
	text?: string;
	content?: ToolResultMessage["content"];
	details?: unknown;
	isError?: boolean;
}): SessionEntry {
	const msgOpts: Parameters<typeof makeToolResultMessage>[0] = {
		toolCallId: opts.toolCallId,
		toolName: opts.toolName,
	};
	if (opts.text !== undefined) msgOpts.text = opts.text;
	if (opts.content !== undefined) msgOpts.content = opts.content;
	if (opts.details !== undefined) msgOpts.details = opts.details;
	if (opts.isError !== undefined) msgOpts.isError = opts.isError;
	return {
		type: "message",
		id: opts.id,
		parentId: null,
		timestamp: opts.timestamp ?? "2026-11-22T10:00:01Z",
		message: makeToolResultMessage(msgOpts),
	};
}

function makeCustomEntry(id: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-11-22T10:00:00Z",
		customType: "note",
		data: { hello: "world" },
	};
}

function createTraceHarness(initialBranch: SessionEntry[] = []) {
	const handlers = new Map<string, Array<() => void>>();
	let commandHandler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;

	const api = {
		on(event: string, fn: () => void): () => void {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(
			name: string,
			config: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		): void {
			if (name === "trace") commandHandler = config.handler;
		},
	};

	trace(api as unknown as ExtensionAPI);
	assert.ok(commandHandler, "trace command should be registered");

	let branch = [...initialBranch];
	const notifications: NotifyRecord[] = [];
	const selectCalls: SelectCall[] = [];
	let selectHandler: SelectHandler = async () => undefined;

	const makeContext = (hasUI = true): ExtensionCommandContext =>
		({
			hasUI,
			sessionManager: {
				getBranch: () => branch,
			},
			ui: {
				notify(message: string, level?: string): void {
					notifications.push({ message, level });
				},
				async select(
					title: string,
					options: string[],
					opts?: { signal?: AbortSignal },
				): Promise<string | undefined> {
					selectCalls.push({
						title,
						options: [...options],
						signal: opts?.signal,
					});
					return selectHandler(title, options, opts);
				},
			},
		}) as unknown as ExtensionCommandContext;

	return {
		notifications,
		selectCalls,
		setBranch(next: SessionEntry[]): void {
			branch = [...next];
		},
		setSelect(fn: SelectHandler): void {
			selectHandler = fn;
		},
		emit(event: "session_start" | "session_tree" | "session_shutdown"): void {
			for (const fn of handlers.get(event) ?? []) fn();
		},
		async run(args = "", hasUI = true): Promise<void> {
			assert.ok(commandHandler);
			await commandHandler(args, makeContext(hasUI));
		},
	};
}

describe("trace: callPreview", () => {
	it("returns empty string for non-record values", () => {
		assert.equal(callPreview(null), "");
		assert.equal(callPreview(undefined), "");
		assert.equal(callPreview("command"), "");
		assert.equal(callPreview(42), "");
		assert.equal(callPreview(["command"]), "");
	});

	it("extracts each of the 9 preview keys", () => {
		assert.equal(callPreview({ command: "git status" }), "git status");
		assert.equal(callPreview({ path: "src/app.ts" }), "src/app.ts");
		assert.equal(callPreview({ file_path: "README.md" }), "README.md");
		assert.equal(callPreview({ pattern: "*.test.ts" }), "*.test.ts");
		assert.equal(callPreview({ query: "extension api" }), "extension api");
		assert.equal(
			callPreview({ url: "https://example.com/docs" }),
			"https://example.com/docs",
		);
		assert.equal(callPreview({ action: "restart" }), "restart");
		assert.equal(callPreview({ agent: "reviewer" }), "reviewer");
		assert.equal(callPreview({ workflow: "release" }), "release");
	});

	it("follows preview key precedence and skips non-string or blank values", () => {
		assert.equal(
			callPreview({
				command: "npm test",
				path: "ignored.ts",
				code: "console.log(1)",
			}),
			"npm test",
		);
		assert.equal(
			callPreview({
				command: 123,
				path: "   \x1b[31m\x1b[0m  ",
				file_path: "picked.ts",
				workflow: "later",
			}),
			"picked.ts",
		);
	});

	it("extracts the first meaningful line from code while skipping blanks and // @options: comments", () => {
		assert.equal(
			callPreview({
				code: "\r\n  // @options: {\"timeout\":5000}\r\n  \n// @options: foo\n  const x = await read('a.ts');\nconsole.log(x);",
			}),
			"const x = await read('a.ts');",
		);
		assert.equal(
			callPreview({
				code: "  \n// @options: only-options\n   \t ",
			}),
			"",
		);
	});

	it("truncates long previews to 40 chars and redacts secrets", () => {
		const longCmd = `echo ${"a".repeat(60)}`;
		const preview = callPreview({ command: longCmd });
		assert.equal(preview.length, 40);
		assert.ok(preview.endsWith("…"));

		const bearerPreview = callPreview({
			command: "curl -H 'Bearer secret_tok_123'",
		});
		assert.ok(!bearerPreview.includes("secret_tok_123"));
		assert.ok(bearerPreview.includes("[REDACTED]"));

		const urlPreview = callPreview({
			url: "https://user:pass@api.test/v1",
		});
		assert.ok(!urlPreview.includes("user:pass"));
		assert.equal(urlPreview, "https://[REDACTED]@api.test/v1");
	});
});

describe("trace: codemodeCalls", () => {
	it("returns empty array for non-codemode messages or invalid details", () => {
		assert.deepEqual(
			codemodeCalls(
				makeToolResultMessage({
					toolCallId: "c1",
					toolName: "bash",
					details: { calls: [{ name: "read", status: "ok" }] },
				}),
			),
			[],
		);
		assert.deepEqual(
			codemodeCalls(
				makeToolResultMessage({
					toolCallId: "c2",
					toolName: "codemode",
					details: null,
				}),
			),
			[],
		);
		assert.deepEqual(
			codemodeCalls(
				makeToolResultMessage({
					toolCallId: "c3",
					toolName: "codemode",
					details: { calls: "not-an-array" },
				}),
			),
			[],
		);
	});

	it("parses valid entries, sanitizes string args/errors directly, and skips malformed entries", () => {
		const msg = makeToolResultMessage({
			toolCallId: "c1",
			toolName: "codemode",
			details: {
				calls: [
					null,
					"bad",
					{ name: "", status: "ok" },
					{ name: 123, status: "ok" },
					{ name: "bash", args: "ls -la", status: "ok", error: "" },
					{
						name: "read",
						args: { path: "src/index.ts" },
						status: "error",
						error: "ENOENT",
					},
					{
						name: "grep",
						args: 999,
						status: "   ",
						error: 404,
					},
					{
						name: "edit",
						status: "very-long-custom-status-value",
					},
					{
						name: "curl",
						args: "\x1b[31mBearer sk-live_1234567890abcdef123456\x1b[0m",
						status: "error",
						error: "\x1b[33mapi_key=ghp_1234567890abcdefghij123456\x1b[0m",
					},
				],
			},
		});
		assert.deepEqual(codemodeCalls(msg), [
			{ name: "bash", args: "ls -la", status: "ok", error: "" },
			{ name: "read", args: "src/index.ts", status: "error", error: "ENOENT" },
			{ name: "grep", args: "", status: "unknown", error: "" },
			{ name: "edit", args: "", status: "very-long-custo…", error: "" },
			{
				name: "curl",
				args: "Bearer [REDACTED]",
				status: "error",
				error: "api_key=[REDACTED]",
			},
		]);
	});
});

describe("trace: /trace command happy paths", () => {
	it("lists results newest-first, supports persistent inspection loop until cancel, and filters by tool/failed", async () => {
		const branch: SessionEntry[] = [
			makeCustomEntry("custom-0"),
			makeAssistantEntry("a1", [
				{ id: "tc-1", name: "bash", arguments: { command: "echo one" } },
				{ id: "tc-2", name: "read", arguments: { path: "missing.ts" } },
			]),
			makeToolResultEntry({
				id: "r1",
				timestamp: "2026-11-22T10:00:01Z",
				toolCallId: "tc-1",
				toolName: "bash",
				text: "one",
			}),
			makeToolResultEntry({
				id: "r2",
				timestamp: "2026-11-22T10:00:02Z",
				toolCallId: "tc-2",
				toolName: "read",
				text: "ENOENT: missing.ts",
				isError: true,
			}),
			makeAssistantEntry("a2", [
				{ id: "tc-3", name: "bash", arguments: { command: "exit 1" } },
			]),
			makeToolResultEntry({
				id: "r3",
				timestamp: "2026-11-22T10:00:03Z",
				toolCallId: "tc-3",
				toolName: "bash",
				text: "boom",
				isError: true,
			}),
		];

		const h = createTraceHarness(branch);
		let step = 0;
		h.setSelect(async (_title, options) => {
			step++;
			if (step === 1) return options[0]; // r3 (failed bash)
			if (step === 2) return options[2]; // r1 (ok bash)
			return undefined; // cancel
		});

		await h.run("");
		assert.equal(h.selectCalls.length, 3);
		const firstCall = h.selectCalls[0];
		assert.ok(firstCall);
		assert.equal(firstCall.title, "Tool trace (1-3 of 3)");
		assert.deepEqual(firstCall.options, [
			"1. failed bash (exit 1) · 2026-11-22T10:00:03Z · #r3",
			"2. failed read (missing.ts) · 2026-11-22T10:00:02Z · #r2",
			"3. ok bash (echo one) · 2026-11-22T10:00:01Z · #r1",
		]);
		assert.equal(h.notifications.length, 2);
		assert.equal(h.notifications[0]?.level, "warning");
		assert.equal(
			h.notifications[0]?.message,
			"1. failed bash (exit 1) · 2026-11-22T10:00:03Z · #r3\nboom",
		);
		assert.equal(h.notifications[1]?.level, "info");
		assert.equal(
			h.notifications[1]?.message,
			"3. ok bash (echo one) · 2026-11-22T10:00:01Z · #r1\none",
		);

		// Filter: /trace bash
		h.selectCalls.length = 0;
		h.setSelect(async () => undefined);
		await h.run("bash");
		assert.equal(h.selectCalls[0]?.options.length, 2);
		assert.ok(h.selectCalls[0]?.options[0]?.includes("#r3"));
		assert.ok(h.selectCalls[0]?.options[1]?.includes("#r1"));

		// Filter: /trace failed
		h.selectCalls.length = 0;
		await h.run("failed");
		assert.equal(h.selectCalls[0]?.options.length, 2);
		assert.ok(h.selectCalls[0]?.options[0]?.includes("#r3"));
		assert.ok(h.selectCalls[0]?.options[1]?.includes("#r2"));

		// Filter: /trace failed bash
		h.selectCalls.length = 0;
		await h.run("failed bash");
		assert.equal(h.selectCalls[0]?.options.length, 1);
		assert.ok(h.selectCalls[0]?.options[0]?.includes("#r3"));
	});

	it("paginates 25 results per page with Older results and Newer results navigation", async () => {
		const entries: SessionEntry[] = [];
		for (let i = 1; i <= 60; i++) {
			entries.push(
				makeToolResultEntry({
					id: `r${i}`,
					timestamp: `2026-11-22T10:${String(i).padStart(2, "0")}:00Z`,
					toolCallId: `tc-${i}`,
					toolName: "bash",
					text: `out-${i}`,
				}),
			);
		}
		const h = createTraceHarness(entries);
		const picks = [
			"Older results →",
			"Older results →",
			"← Newer results",
			undefined,
		];
		let idx = 0;
		h.setSelect(async () => picks[idx++]);

		await h.run("");
		assert.equal(h.selectCalls.length, 4);

		// Page 1: 1-25 of 60, Older only
		assert.equal(h.selectCalls[0]?.title, "Tool trace (1-25 of 60)");
		assert.equal(h.selectCalls[0]?.options.length, 26);
		assert.ok(h.selectCalls[0]?.options[0]?.startsWith("1. ok bash ·"));
		assert.ok(h.selectCalls[0]?.options[0]?.endsWith("#r60"));
		assert.ok(!h.selectCalls[0]?.options.includes("← Newer results"));
		assert.equal(h.selectCalls[0]?.options.at(-1), "Older results →");

		// Page 2: 26-50 of 60, both Newer and Older
		assert.equal(h.selectCalls[1]?.title, "Tool trace (26-50 of 60)");
		assert.equal(h.selectCalls[1]?.options.length, 27);
		assert.equal(h.selectCalls[1]?.options.at(-2), "← Newer results");
		assert.equal(h.selectCalls[1]?.options.at(-1), "Older results →");

		// Page 3: 51-60 of 60, Newer only
		assert.equal(h.selectCalls[2]?.title, "Tool trace (51-60 of 60)");
		assert.equal(h.selectCalls[2]?.options.length, 11);
		assert.ok(h.selectCalls[2]?.options[9]?.endsWith("#r1"));
		assert.equal(h.selectCalls[2]?.options.at(-1), "← Newer results");
		assert.ok(!h.selectCalls[2]?.options.includes("Older results →"));

		// Back to Page 2
		assert.equal(h.selectCalls[3]?.title, "Tool trace (26-50 of 60)");
	});

	it("does not show pagination controls when there are exactly 25 results", async () => {
		const entries: SessionEntry[] = [];
		for (let i = 1; i <= 25; i++) {
			entries.push(
				makeToolResultEntry({
					id: `r${i}`,
					toolCallId: `tc-${i}`,
					toolName: "read",
					text: `line ${i}`,
				}),
			);
		}
		const h = createTraceHarness(entries);
		await h.run("");
		assert.equal(h.selectCalls[0]?.options.length, 25);
		assert.ok(!h.selectCalls[0]?.options.includes("Older results →"));
		assert.ok(!h.selectCalls[0]?.options.includes("← Newer results"));
	});
});

describe("trace: validation, empty state, and codemode badges", () => {
	it("throws when !ctx.hasUI", async () => {
		const h = createTraceHarness([]);
		await assert.rejects(() => h.run("", false), {
			message: "/trace requires an interactive Pi or RPC UI.",
		});
	});

	it("warns on invalid argument count or order", async () => {
		const h = createTraceHarness([]);
		await h.run("bash failed");
		await h.run("failed bash extra");
		await h.run("read bash");
		assert.equal(h.selectCalls.length, 0);
		assert.deepEqual(h.notifications, [
			{ message: "Usage: /trace [failed] [tool]", level: "warning" },
			{ message: "Usage: /trace [failed] [tool]", level: "warning" },
			{ message: "Usage: /trace [failed] [tool]", level: "warning" },
		]);
	});

	it("notifies when branch is empty or filter matches nothing", async () => {
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r1",
				toolCallId: "t1",
				toolName: "read",
				text: "ok",
			}),
		]);
		await h.run("failed");
		await h.run("bash");
		h.setBranch([]);
		await h.run("");
		assert.equal(h.selectCalls.length, 0);
		assert.equal(h.notifications.length, 3);
		for (const n of h.notifications) {
			assert.deepEqual(n, {
				message: "No matching tool results on this branch.",
				level: "info",
			});
		}
	});

	it("renders per-tool codemode status badges (ok vs nested-err, [bash], [bash 1/2 err], [1/2 err]) and outer isError vs caught inner error", async () => {
		const branch: SessionEntry[] = [
			makeAssistantEntry("a1", [
				{
					id: "cm1",
					name: "codemode",
					arguments: { code: "// @options: {}\nawait run();" },
				},
				{
					id: "cm2",
					name: "codemode",
					arguments: { code: "throw new Error('outer');" },
				},
			]),
			// Caught inner error: outer isError=false, bash has 1/2 err, read has 0/1 err
			makeToolResultEntry({
				id: "r-cm1",
				toolCallId: "cm1",
				toolName: "codemode",
				text: "recovered",
				isError: false,
				details: {
					calls: [
						{ name: "read", args: { path: "a.ts" }, status: "ok" },
						{ name: "bash", args: "false", status: "error", error: "exit 1" },
						{ name: "bash", args: "true", status: "ok" },
					],
				},
			}),
			// Outer error with all nested calls ok
			makeToolResultEntry({
				id: "r-cm2",
				toolCallId: "cm2",
				toolName: "codemode",
				text: "Error: outer",
				isError: true,
				details: {
					calls: [{ name: "read", args: { path: "b.ts" }, status: "ok" }],
				},
			}),
		];

		const h = createTraceHarness(branch);

		// Unfiltered /trace
		h.setSelect(async (_t, opts) =>
			h.notifications.length === 0 ? opts[1] : undefined,
		);
		await h.run("");
		assert.ok(
			h.selectCalls[0]?.options[0]?.startsWith(
				"1. failed codemode (throw new Error('outer');)",
			),
		);
		assert.ok(
			h.selectCalls[0]?.options[1]?.startsWith(
				"2. nested-err codemode ([1/3 err] await run();)",
			),
		);
		assert.equal(h.notifications[0]?.level, "warning");
		assert.ok(h.notifications[0]?.message.includes("[Nested calls]"));
		assert.ok(h.notifications[0]?.message.includes("- ok read (a.ts)"));
		assert.ok(
			h.notifications[0]?.message.includes("- error bash (false): exit 1"),
		);

		// Per-tool /trace bash -> [bash 1/2 err], nested-err, warning
		h.selectCalls.length = 0;
		h.notifications.length = 0;
		let picked = false;
		h.setSelect(async (_t, opts) => {
			if (!picked) {
				picked = true;
				return opts[0];
			}
			return undefined;
		});
		await h.run("bash");
		assert.equal(h.selectCalls[0]?.options.length, 1);
		assert.ok(
			h.selectCalls[0]?.options[0]?.startsWith(
				"1. nested-err codemode ([bash 1/2 err] await run();)",
			),
		);
		assert.equal(h.notifications[0]?.level, "warning");

		// Per-tool /trace read -> r-cm1 has ok status ([read]) and info level! r-cm2 has outer failed ([read]) and warning!
		h.selectCalls.length = 0;
		h.notifications.length = 0;
		picked = false;
		h.setSelect(async (_t, opts) => {
			if (!picked) {
				picked = true;
				return opts[1]; // r-cm1
			}
			return undefined;
		});
		await h.run("read");
		assert.equal(h.selectCalls[0]?.options.length, 2);
		assert.ok(
			h.selectCalls[0]?.options[0]?.startsWith(
				"1. failed codemode ([read] throw new Error('outer');)",
			),
		);
		assert.ok(
			h.selectCalls[0]?.options[1]?.startsWith(
				"2. ok codemode ([read] await run();)",
			),
		);
		assert.equal(h.notifications[0]?.level, "info");

		// /trace failed read -> neither matches because no `read` call failed!
		h.selectCalls.length = 0;
		h.notifications.length = 0;
		h.setSelect(async () => undefined);
		await h.run("failed read");
		assert.equal(h.selectCalls.length, 0);
		assert.deepEqual(h.notifications[0], {
			message: "No matching tool results on this branch.",
			level: "info",
		});

		// /trace failed -> both r-cm2 (outer isError) and r-cm1 (caught inner error) match
		h.selectCalls.length = 0;
		h.notifications.length = 0;
		await h.run("failed");
		assert.equal(h.selectCalls[0]?.options.length, 2);

		// /trace failed bash -> only r-cm1 matches
		h.selectCalls.length = 0;
		h.notifications.length = 0;
		await h.run("failed bash");
		assert.equal(h.selectCalls[0]?.options.length, 1);
		assert.ok(h.selectCalls[0]?.options[0]?.includes("#r-cm1"));
	});
});

describe("trace: selectNestedCalls prioritization and diagnostics", () => {
	it("shows all <=10 nested calls without #index or header", async () => {
		const calls = Array.from({ length: 10 }, (_, i) => ({
			name: "read",
			args: `file-${i + 1}.ts`,
			status: "ok",
		}));
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r1",
				toolCallId: "c1",
				toolName: "codemode",
				text: "done",
				details: { calls },
			}),
		]);
		let picked = false;
		h.setSelect(async (_t, opts) => {
			if (!picked) {
				picked = true;
				return opts[0];
			}
			return undefined;
		});
		await h.run("");
		const msg = h.notifications[0]?.message ?? "";
		assert.ok(msg.includes("[Nested calls]"));
		assert.ok(!msg.includes("(Showing"));
		assert.ok(!msg.includes("#1 "));
		assert.ok(msg.includes("- ok read (file-1.ts)"));
		assert.ok(msg.includes("- ok read (file-10.ts)"));
	});

	it("uses last 10 when >10 nested calls and tail covers all failures", async () => {
		const calls = Array.from({ length: 14 }, (_, i) => ({
			name: "read",
			args: `f${i + 1}.ts`,
			status: i === 12 ? "error" : "ok",
			error: i === 12 ? "boom" : "",
		}));
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r1",
				toolCallId: "c1",
				toolName: "codemode",
				text: "done",
				details: { calls },
			}),
		]);
		let picked = false;
		h.setSelect(async (_t, opts) => {
			if (!picked) {
				picked = true;
				return opts[0];
			}
			return undefined;
		});
		await h.run("");
		const msg = h.notifications[0]?.message ?? "";
		assert.ok(msg.includes("(Showing last 10 of 14)"));
		assert.ok(!msg.includes("#4 "));
		assert.ok(msg.includes("- #5 ok read (f5.ts)"));
		assert.ok(msg.includes("- #13 error read (f13.ts): boom"));
		assert.ok(msg.includes("- #14 ok read (f14.ts)"));
	});

	it("prioritizes <tool> match in head even when ok (both when tail has none and when tail also has <tool>)", async () => {
		const calls = [
			{ name: "bash", args: "early-cmd", status: "ok" },
			...Array.from({ length: 11 }, (_, i) => ({
				name: "read",
				args: `f${i + 2}.ts`,
				status: "ok",
			})),
			{ name: "bash", args: "late-cmd", status: "ok" },
		];
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r1",
				toolCallId: "c1",
				toolName: "codemode",
				text: "done",
				details: { calls },
			}),
		]);
		let picked = false;
		h.setSelect(async (_t, opts) => {
			if (!picked) {
				picked = true;
				return opts[0];
			}
			return undefined;
		});
		await h.run("bash");
		const msg = h.notifications[0]?.message ?? "";
		assert.ok(msg.includes("(Showing 10 of 13; errors/matches prioritized)"));
		assert.ok(msg.includes("- #1 ok bash (early-cmd)"));
		assert.ok(msg.includes("- #13 ok bash (late-cmd)"));
	});

	it("prioritizes <tool> failed -> <tool> ok -> unrelated failed -> recent in ascending #index order", async () => {
		// 15 calls (indices 1..15):
		// #1: bash error (tier 1 - tool failed)
		// #2: bash cancelled (tier 1 - tool failed)
		// #3: bash ok (tier 2 - tool ok)
		// #4: read error (tier 3 - unrelated failed)
		// #5: grep cancelled (tier 3 - unrelated failed)
		// #6..#10: read ok (older)
		// #11: bash ok (tier 2 - tool ok)
		// #12: edit error (tier 3 - unrelated failed)
		// #13..#15: read ok (tier 4 - most recent)
		// Sorted ascending: #1, #2, #3, #4, #5, #11, #12, #13, #14, #15
		const calls = [
			{ name: "bash", args: "c1", status: "error", error: "e1" },
			{ name: "bash", args: "c2", status: "cancelled", error: "e2" },
			{ name: "bash", args: "c3", status: "ok" },
			{ name: "read", args: "c4", status: "error", error: "e4" },
			{ name: "grep", args: "c5", status: "cancelled" },
			{ name: "read", args: "c6", status: "ok" },
			{ name: "read", args: "c7", status: "ok" },
			{ name: "read", args: "c8", status: "ok" },
			{ name: "read", args: "c9", status: "ok" },
			{ name: "read", args: "c10", status: "ok" },
			{ name: "bash", args: "c11", status: "ok" },
			{ name: "edit", args: "c12", status: "error", error: "e12" },
			{ name: "read", args: "c13", status: "ok" },
			{ name: "read", args: "c14", status: "ok" },
			{ name: "read", args: "c15", status: "ok" },
		];
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r1",
				toolCallId: "cm",
				toolName: "codemode",
				text: "done",
				details: { calls },
			}),
		]);
		let picked = false;
		h.setSelect(async (_t, opts) => {
			if (!picked) {
				picked = true;
				return opts[0];
			}
			return undefined;
		});
		await h.run("bash");
		const msg = h.notifications[0]?.message ?? "";
		assert.ok(msg.includes("(Showing 10 of 15; errors/matches prioritized)"));
		const indices = [...msg.matchAll(/^- #(\d+) /gm)].map((m) => Number(m[1]));
		assert.deepEqual(indices, [1, 2, 3, 4, 5, 11, 12, 13, 14, 15]);
	});

	it("assembles bounded 16 KiB backward tail across multiple blocks, drops mid-line cut, preserves exact-fit latest block, and handles image-only fallback", async () => {
		// Case 1: multiple blocks with mid-line cut in earlier block
		const earlier = `DROPPED_SECRET_PART\nKEPT_EARLIER\n${"x".repeat(16_370)}`;
		const later = "FINAL_LINE";
		// Case 2: exact 16,384-byte latest block + earlier non-empty block (space <= 0)
		const exactBlock = `FIRST_LINE_INTACT\n${"y".repeat(16_384 - "FIRST_LINE_INTACT\n".length - "\nEND".length)}\nEND`;
		assert.equal(exactBlock.length, 16_384);
		// Case 3: image-only content
		const branch: SessionEntry[] = [
			makeToolResultEntry({
				id: "r-mid",
				toolCallId: "t-mid",
				toolName: "bash",
				content: [
					{ type: "text", text: "SKIPPED_TOO_OLD" },
					{ type: "text", text: earlier },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "" },
					{ type: "text", text: later },
				],
			}),
			makeToolResultEntry({
				id: "r-exact",
				toolCallId: "t-exact",
				toolName: "bash",
				content: [
					{ type: "text", text: "EARLIER_BLOCK" },
					{ type: "text", text: exactBlock },
				],
			}),
			makeToolResultEntry({
				id: "r-img",
				toolCallId: "t-img",
				toolName: "read",
				content: [{ type: "image", data: "BBBB", mimeType: "image/png" }],
			}),
		];

		const h = createTraceHarness(branch);
		let step = 0;
		h.setSelect(async (_t, opts) => {
			step++;
			if (step <= 3) return opts[step - 1];
			return undefined;
		});
		await h.run("");
		assert.equal(h.notifications.length, 3);

		// r-img (newest, index 0)
		assert.ok(
			h.notifications[0]?.message.endsWith(
				"(No displayable text in the retained output.)",
			),
		);

		// r-exact (index 1): exact 16 KiB block keeps its lines intact and marks [Last output only]
		const exactMsg = h.notifications[1]?.message ?? "";
		assert.ok(exactMsg.includes("[Last output only]"));
		assert.ok(exactMsg.includes("END"));
		assert.ok(!exactMsg.includes("EARLIER_BLOCK"));

		// r-mid (index 2): drops partial first line from mid-line cut, retains FINAL_LINE
		const midMsg = h.notifications[2]?.message ?? "";
		assert.ok(midMsg.includes("[Last output only]"));
		assert.ok(!midMsg.includes("DROPPED_SECRET_PART"));
		assert.ok(!midMsg.includes("KEPT_EARLIER"));
		assert.ok(midMsg.includes("FINAL_LINE"));
	});

	it("redacts secrets across previews, nested call args, nested call errors, and output tail", async () => {
		const secretKey = "sk-live_1234567890abcdef123456";
		const secretToken = "ghp_1234567890abcdefghij123456";
		const branch: SessionEntry[] = [
			makeAssistantEntry("a1", [
				{
					id: "cm-sec",
					name: "codemode",
					arguments: {
						code: `fetch("https://u:p@host", { token: "${secretKey}" })`,
					},
				},
			]),
			makeToolResultEntry({
				id: "r-sec",
				toolCallId: "cm-sec",
				toolName: "codemode",
				text: `Authorization: Bearer ${secretToken}\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`,
				details: {
					calls: [
						{
							name: "bash",
							args: `curl -H "Bearer ${secretToken}"`,
							status: "error",
							error: `failed with api_key=${secretKey}`,
						},
					],
				},
			}),
		];
		const h = createTraceHarness(branch);
		let picked = false;
		h.setSelect(async (_t, opts) => {
			if (!picked) {
				picked = true;
				return opts[0];
			}
			return undefined;
		});
		await h.run("");
		const optionLabel = h.selectCalls[0]?.options[0] ?? "";
		const output = h.notifications[0]?.message ?? "";
		assert.ok(!optionLabel.includes("u:p"));
		assert.ok(!optionLabel.includes(secretKey));
		assert.ok(!output.includes(secretKey));
		assert.ok(!output.includes(secretToken));
		assert.ok(output.includes("[REDACTED]"));
		assert.ok(output.includes("[REDACTED PRIVATE KEY]"));
	});
});

describe("trace: abort lifecycle and stale branch detection", () => {
	for (const event of [
		"session_tree",
		"session_start",
		"session_shutdown",
	] as const) {
		it(`aborts active picker signal on ${event}`, async () => {
			const h = createTraceHarness([
				makeToolResultEntry({
					id: "r1",
					toolCallId: "t1",
					toolName: "bash",
					text: "ok",
				}),
			]);
			let capturedSignal: AbortSignal | undefined;
			let resolveSelect: ((value: string | undefined) => void) | undefined;
			h.setSelect(
				(_t, _opts, opts) =>
					new Promise<string | undefined>((resolve) => {
						capturedSignal = opts?.signal;
						resolveSelect = resolve;
					}),
			);

			const runPromise = h.run("");
			assert.ok(capturedSignal);
			assert.equal(capturedSignal.aborted, false);
			h.emit(event);
			assert.equal(capturedSignal.aborted, true);
			resolveSelect?.(h.selectCalls[0]?.options[0]);
			await runPromise;
			assert.equal(h.notifications.length, 0);
		});
	}

	it("aborts an earlier overlapping /trace picker when a second /trace opens", async () => {
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r1",
				toolCallId: "t1",
				toolName: "bash",
				text: "ok",
			}),
		]);
		const resolvers: Array<(v: string | undefined) => void> = [];
		const signals: Array<AbortSignal | undefined> = [];
		h.setSelect(
			(_t, _opts, opts) =>
				new Promise<string | undefined>((resolve) => {
					signals.push(opts?.signal);
					resolvers.push(resolve);
				}),
		);

		const first = h.run("");
		assert.equal(signals[0]?.aborted, false);
		const second = h.run("");
		assert.equal(signals[0]?.aborted, true);
		assert.equal(signals[1]?.aborted, false);

		resolvers[0]?.(h.selectCalls[0]?.options[0]);
		resolvers[1]?.(undefined);
		await Promise.all([first, second]);
		assert.equal(h.notifications.length, 0);
	});

	it("notifies and exits when the selected entry is no longer on the branch, and swallows UI disconnect errors", async () => {
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r1",
				toolCallId: "t1",
				toolName: "bash",
				text: "ok",
			}),
		]);
		h.setSelect(async (_t, opts) => {
			h.setBranch([]);
			return opts[0];
		});
		await h.run("");
		assert.equal(h.selectCalls.length, 1);
		assert.deepEqual(h.notifications, [
			{
				message: "The selected result is no longer on this branch.",
				level: "warning",
			},
		]);

		// Rejecting select (e.g., RPC UI closed mid-picker) exits cleanly without throwing
		h.setBranch([
			makeToolResultEntry({
				id: "r2",
				toolCallId: "t2",
				toolName: "bash",
				text: "ok",
			}),
		]);
		h.setSelect(async () => {
			throw new Error("RPC client disconnected");
		});
		await assert.doesNotReject(() => h.run(""));
	});
});
