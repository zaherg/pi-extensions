import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import workerBoard from "../index.ts";
import { latestBatch, workerRows } from "../report.ts";

function makeAssistantEntry(
	id: string,
	content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-22T10:00:00Z",
		message: {
			role: "assistant",
			content: content.map((block) =>
				block.type === "toolCall"
					? {
							type: "toolCall" as const,
							id: block.id,
							name: block.name,
							arguments: block.arguments as ToolCall["arguments"],
						}
					: block,
			),
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

function makeToolResultEntry(opts: {
	id: string;
	toolCallId: string;
	toolName: string;
	details?: unknown;
	isError?: boolean;
}): SessionEntry {
	return {
		type: "message",
		id: opts.id,
		parentId: null,
		timestamp: "2026-11-22T10:00:01Z",
		message: {
			role: "toolResult",
			toolCallId: opts.toolCallId,
			toolName: opts.toolName,
			content: [{ type: "text", text: "done" }],
			...(opts.details !== undefined
				? { details: opts.details as NonNullable<ToolResultMessage["details"]> }
				: {}),
			isError: opts.isError ?? false,
			timestamp: 1,
		},
	};
}

type WidgetValue = string[] | (() => Component) | undefined;

interface WidgetCall {
	key: string;
	value: WidgetValue;
}

interface NotifyCall {
	message: string;
	level: string | undefined;
}

function createBoardHarness(opts?: {
	branch?: SessionEntry[];
	mode?: "tui" | "rpc";
	hasUI?: boolean;
}) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	let commandHandler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;

	const api = {
		on(event: string, fn: (event: unknown, ctx: ExtensionContext) => void): () => void {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(
			name: string,
			config: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		): void {
			if (name === "workers") commandHandler = config.handler;
		},
	};

	workerBoard(api as unknown as ExtensionAPI);
	assert.ok(commandHandler, "workers command should be registered");

	let branch = [...(opts?.branch ?? [])];
	let mode: "tui" | "rpc" = opts?.mode ?? "rpc";
	let hasUI = opts?.hasUI ?? true;
	const widgetCalls: WidgetCall[] = [];
	const notifications: NotifyCall[] = [];

	const makeContext = (override?: { hasUI?: boolean; mode?: "tui" | "rpc" }): ExtensionContext =>
		({
			hasUI: override?.hasUI ?? hasUI,
			mode: override?.mode ?? mode,
			sessionManager: {
				getBranch: () => branch,
			},
			ui: {
				notify(message: string, level?: string): void {
					notifications.push({ message, level });
				},
				setWidget(key: string, value: WidgetValue): void {
					widgetCalls.push({ key, value });
				},
			},
		}) as unknown as ExtensionContext;

	return {
		widgetCalls,
		notifications,
		setBranch(next: SessionEntry[]): void {
			branch = [...next];
		},
		setMode(next: "tui" | "rpc"): void {
			mode = next;
		},
		setHasUI(next: boolean): void {
			hasUI = next;
		},
		emit(eventName: string, event: unknown, ctxOverride?: { hasUI?: boolean; mode?: "tui" | "rpc" }): void {
			const ctx = makeContext(ctxOverride);
			for (const fn of handlers.get(eventName) ?? []) fn(event, ctx);
		},
		async runWorkers(
			args = "",
			ctxOverride?: { hasUI?: boolean; mode?: "tui" | "rpc" },
		): Promise<void> {
			assert.ok(commandHandler);
			await commandHandler(args, makeContext(ctxOverride) as unknown as ExtensionCommandContext);
		},
	};
}

describe("worker-board report: modes, statuses, and priorities", () => {
	it("handles single mode with explicit status, blocker, task, and lastTool priority", () => {
		const rows = workerRows(
			"e1",
			{ agent: "planner", task: "Design schema" },
			{
				mode: "single",
				results: [
					{
						agent: "planner",
						status: "blocked",
						blocker: "Waiting on API token approval",
						messages: [
							{
								role: "assistant",
								content: [{ type: "toolCall", name: "read" }],
							},
							{ role: "toolResult", toolName: "bash" },
						],
					},
				],
			},
			"finished",
		);
		assert.deepEqual(rows, [
			{
				priority: 0,
				text: "blocked planner #e1/1 · blocked by: Waiting on API token approval · Design schema · last: bash",
			},
		]);
	});

	it("orders priorities as blocked/failed (0) < aborted (1) < running (2) < pending (3) < completed (4)", () => {
		const rows = workerRows(
			"p1",
			{
				tasks: [
					{ agent: "a1", task: "done task" },
					{ agent: "a2", task: "queued task" },
					{ agent: "a3", task: "live task" },
					{ agent: "a4", task: "cancelled task" },
					{ agent: "a5", task: "broken task" },
					{ agent: "a6", task: "stuck task" },
				],
			},
			{
				mode: "parallel",
				results: [
					{ agent: "a1", status: "completed" },
					{ agent: "a2", status: "pending" },
					{ agent: "a3", status: "running" },
					{ agent: "a4", status: "aborted" },
					{ agent: "a5", status: "failed", blocker: "ignored when not blocked" },
					{ agent: "a6", status: "blocked", blocker: "needs schema" },
				],
			},
			"live",
		);
		assert.deepEqual(
			rows.map((r) => r.priority),
			[4, 3, 2, 1, 0, 0],
		);
		// Blocker is only included when status is blocked
		assert.ok(!rows[4]?.text.includes("blocked by:"));
		assert.ok(rows[5]?.text.includes("blocked by: needs schema"));
	});

	it("infers status from exitCode (0 vs non-zero) and settled stopReason/state variants without exitCode", () => {
		const cases: Array<{ raw: Record<string, unknown>; expectedText: string; expectedPriority: number }> = [
			{ raw: { agent: "w", exitCode: 0 }, expectedText: "completed w #s/1", expectedPriority: 4 },
			{ raw: { agent: "w", exitCode: 137 }, expectedText: "failed w #s/1", expectedPriority: 0 },
			{ raw: { agent: "w", stopReason: "aborted" }, expectedText: "aborted w #s/1", expectedPriority: 1 },
			{ raw: { agent: "w", state: "STOPPED" }, expectedText: "aborted w #s/1", expectedPriority: 1 },
			{ raw: { agent: "w", state: "cancelled" }, expectedText: "aborted w #s/1", expectedPriority: 1 },
			{ raw: { agent: "w", state: "canceled" }, expectedText: "aborted w #s/1", expectedPriority: 1 },
			{ raw: { agent: "w", state: "blocked", blocker: "lock" }, expectedText: "blocked w #s/1 · blocked by: lock", expectedPriority: 0 },
			{ raw: { agent: "w", stopReason: "error" }, expectedText: "failed w #s/1", expectedPriority: 0 },
			{ raw: { agent: "w", state: "failed" }, expectedText: "failed w #s/1", expectedPriority: 0 },
			{ raw: { agent: "w", state: "error" }, expectedText: "failed w #s/1", expectedPriority: 0 },
			{ raw: { agent: "w", state: "completed" }, expectedText: "completed w #s/1", expectedPriority: 4 },
			{ raw: { agent: "w", state: "complete" }, expectedText: "completed w #s/1", expectedPriority: 4 },
			{ raw: { agent: "w", state: "succeeded" }, expectedText: "completed w #s/1", expectedPriority: 4 },
			{ raw: { agent: "w", state: "done" }, expectedText: "completed w #s/1", expectedPriority: 4 },
			{ raw: { agent: "w", state: "pending" }, expectedText: "last reported pending w #s/1", expectedPriority: 3 },
			{ raw: { agent: "w", state: "queued" }, expectedText: "last reported pending w #s/1", expectedPriority: 3 },
			{ raw: { agent: "w", state: "running" }, expectedText: "last reported running w #s/1", expectedPriority: 2 },
			{ raw: { agent: "w", state: "active" }, expectedText: "last reported running w #s/1", expectedPriority: 2 },
		];
		for (const c of cases) {
			const rows = workerRows("s", {}, { mode: "single", results: [c.raw] }, "finished");
			assert.deepEqual(rows, [{ priority: c.expectedPriority, text: c.expectedText }]);
		}

		// Prototype keys like "toString" are rejected as status
		const protoRows = workerRows(
			"s",
			{},
			{ mode: "single", results: [{ agent: "w", status: "toString" }] },
			"finished",
		);
		assert.deepEqual(protoRows, [{ priority: 1, text: "#s/1 Unsupported worker report." }]);
	});

	it("scans messages backward for toolResult/toolCall and falls back to toolCalls", () => {
		// Prefers later assistant toolCall over earlier toolResult
		const fromAssistant = workerRows(
			"t1",
			{},
			{
				mode: "single",
				results: [
					{
						agent: "dev",
						status: "running",
						messages: [
							{ role: "toolResult", toolName: "read" },
							{
								role: "assistant",
								content: [
									{ type: "toolCall", name: "grep" },
									{ type: "toolCall", name: "edit" },
									{ type: "toolCall", name: "   " },
								],
							},
						],
						toolCalls: [{ text: "fallback-tool" }],
					},
				],
			},
			"live",
		);
		assert.equal(fromAssistant[0]?.text, "running dev #t1/1 · last: edit");

		// Skips blank toolResult and falls back to toolCalls backward scan
		const fromFallback = workerRows(
			"t2",
			{},
			{
				mode: "single",
				results: [
					{
						agent: "dev",
						status: "completed",
						messages: [{ role: "toolResult", toolName: "   " }],
						toolCalls: [{ text: "first" }, { text: "second" }, { text: "" }],
					},
				],
			},
			"finished",
		);
		assert.equal(fromFallback[0]?.text, "completed dev #t2/1 · last: second");
	});

	it("enforces chain prompt safety by reading task only from matching args.chain[i]", () => {
		const rows = workerRows(
			"ch1",
			{
				chain: [
					{ agent: "scout", task: "Find bugs" },
					{ agent: "fixer", task: "Fix bugs" },
				],
			},
			{
				mode: "chain",
				results: [
					{ agent: "scout", exitCode: 0, task: "SENSITIVE PRIOR OUTPUT LEAK" },
					{ agent: "reviewer", exitCode: 0, task: "UNMATCHED AGENT LEAK" },
				],
			},
			"finished",
		);
		assert.deepEqual(rows, [
			{ priority: 4, text: "completed scout #ch1/1 · Find bugs" },
			{ priority: 4, text: "completed reviewer #ch1/2" },
		]);
	});

	it("handles missing phase, incompatible/undefined details, malformed slots, and empty results declined confirmation", () => {
		assert.deepEqual(workerRows("m1", {}, undefined, "missing"), [
			{ priority: 1, text: "#m1 No worker outcome recorded." },
		]);
		assert.deepEqual(workerRows("l1", {}, undefined, "live"), [
			{ priority: 1, text: "#l1 Awaiting worker report." },
		]);
		assert.deepEqual(workerRows("f1", {}, undefined, "failed"), [
			{ priority: 0, text: "#f1 Call failed; no worker outcome reported." },
		]);
		assert.deepEqual(workerRows("i1", {}, { mode: "unknown", results: [] }, "finished"), [
			{ priority: 1, text: "#i1 No compatible worker report." },
		]);
		assert.deepEqual(workerRows("i2", {}, { mode: "single", results: "bad" }, "live"), [
			{ priority: 1, text: "#i2 No compatible worker report." },
		]);

		// Empty results: [] (e.g. declined confirmation)
		assert.deepEqual(workerRows("d1", {}, { mode: "single", results: [] }, "finished"), [
			{ priority: 1, text: "#d1 No worker outcome reported." },
		]);
		assert.deepEqual(workerRows("d2", {}, { mode: "single", results: [] }, "live"), [
			{ priority: 1, text: "#d2 Awaiting worker report." },
		]);
		assert.deepEqual(workerRows("d3", {}, { mode: "single", results: [] }, "failed"), [
			{ priority: 0, text: "#d3 Call failed; no worker outcome reported." },
		]);

		// Malformed slots and unshifted Call failed. banner when phase=failed without failed/aborted worker
		const malformed = workerRows(
			"mf",
			{},
			{
				mode: "parallel",
				results: [
					null,
					{ agent: "", status: "completed" },
					{ agent: "dev" }, // no status inferable when settled
					{ agent: "ok-dev", exitCode: 0 },
				],
			},
			"failed",
		);
		assert.deepEqual(malformed, [
			{ priority: 0, text: "#mf Call failed." },
			{ priority: 1, text: "#mf/1 Unsupported worker report." },
			{ priority: 1, text: "#mf/2 Unsupported worker report." },
			{ priority: 1, text: "#mf/3 Unsupported worker report." },
			{ priority: 4, text: "completed ok-dev #mf/4" },
		]);

		// No Call failed. banner when a worker already reported failed/aborted
		const alreadyFailed = workerRows(
			"af",
			{},
			{ mode: "single", results: [{ agent: "dev", exitCode: 1 }] },
			"failed",
		);
		assert.deepEqual(alreadyFailed, [{ priority: 0, text: "failed dev #af/1" }]);
	});

	it("handles workflowChildren.children, top-level array tolerance, details.workflow metadata, and failure banners", () => {
		// workflowChildren.children with failure banner when no child failed
		const withBanner = workerRows(
			"wf1",
			{ workflow: "release" },
			{
				mode: "workflow",
				results: [],
				workflow: { state: "failed", failureKind: "timeout" },
				workflowChildren: {
					workflowState: "failed",
					children: [
						{
							agent: "builder",
							state: "running",
							sessionName: "build-step",
							currentTool: "bash",
						},
						{
							childId: "child-2",
							exitCode: 0,
							messages: [{ role: "toolResult", toolName: "read" }],
						},
						"bad-slot",
					],
				},
			},
			"finished",
		);
		assert.deepEqual(withBanner, [
			{ priority: 0, text: "#wf1 Workflow failed (timeout)." },
			{ priority: 2, text: "last reported running builder #wf1/1 · build-step · last: bash" },
			{ priority: 4, text: "completed child-2 #wf1/2 · last: read" },
			{ priority: 1, text: "#wf1/3 Unsupported worker report." },
		]);

		// Top-level workflowChildren array tolerance + no duplicate banner when a child failed
		const topArray = workerRows(
			"wf2",
			{},
			{
				mode: "workflow",
				results: [],
				workflow: { state: "error" },
				workflowChildren: [
					{ agent: "tester", status: "failed" },
					{ agent: "linter", status: "completed" },
				],
			},
			"failed",
		);
		assert.deepEqual(topArray, [
			{ priority: 0, text: "failed tester #wf2/1" },
			{ priority: 4, text: "completed linter #wf2/2" },
		]);

		// Generic failure banner without failureKind when phase === "failed"
		const genericBanner = workerRows(
			"wf3",
			{},
			{
				mode: "workflow",
				results: [],
				workflowChildren: [{ agent: "tester", status: "completed" }],
			},
			"failed",
		);
		assert.equal(genericBanner[0]?.text, "#wf3 Workflow failed.");

		// Workflow without children: failureKind, stopCause, async running, pending, completed
		assert.deepEqual(
			workerRows(
				"wf4",
				{ workflow: "deploy", mission: "Ship v2" },
				{
					mode: "workflow",
					results: [],
					workflow: { state: "stopped", stopCause: "user_cancel" },
				},
				"finished",
			),
			[{ priority: 1, text: "aborted deploy #wf4 · Ship v2 · stopped: user_cancel" }],
		);
		assert.deepEqual(
			workerRows(
				"wf5",
				{ workflow: "ci", mission: "Run suite" },
				{
					mode: "workflow",
					results: [],
					asyncId: "async-99",
					workflow: { state: "running" },
				},
				"finished",
			),
			[{ priority: 2, text: "last reported running ci #wf5 · Run suite · async" }],
		);
		assert.deepEqual(
			workerRows(
				"wf6",
				{},
				{
					mode: "workflow",
					results: [],
					workflow: { failureKind: "crash" },
				},
				"finished",
			),
			[{ priority: 0, text: "failed workflow #wf6 · failure: crash" }],
		);
		assert.deepEqual(
			workerRows(
				"wf7",
				{},
				{
					mode: "workflow",
					results: [],
					workflow: { state: "queued" },
				},
				"finished",
			),
			[{ priority: 3, text: "last reported pending workflow #wf7" }],
		);
	});

	it("expands async parallel/chain batches and single async calls across live, finished, and failed phases", () => {
		const parallelLive = workerRows(
			"ap",
			{
				tasks: [
					{ agent: "scout", task: "Check API" },
					{ task: "Check DB" },
				],
			},
			{ mode: "parallel", results: [], asyncId: "job-1" },
			"live",
		);
		assert.deepEqual(parallelLive, [
			{ priority: 2, text: "running (async) scout #ap/1 · Check API" },
			{ priority: 2, text: "running (async) worker #ap/2 · Check DB" },
		]);

		const chainSettled = workerRows(
			"ac",
			{ chain: [{ agent: "a", task: "Step 1" }] },
			{ mode: "chain", results: [], asyncId: "job-2" },
			"finished",
		);
		assert.deepEqual(chainSettled, [
			{ priority: 2, text: "last reported async a #ac/1 · Step 1" },
		]);

		const singleFailed = workerRows(
			"as",
			{ agent: "runner", task: "Run tests" },
			{ mode: "single", results: [], asyncId: "job-3" },
			"failed",
		);
		assert.deepEqual(singleFailed, [
			{ priority: 0, text: "failed runner #as · Run tests" },
		]);
	});

	it("formats management mode with lifecycleStatus.processTerminal.state and steering.state", () => {
		assert.deepEqual(
			workerRows(
				"mg1",
				{ action: "cancel" },
				{
					mode: "management",
					results: [],
					lifecycleStatus: { processTerminal: { state: "terminated" } },
				},
				"finished",
			),
			[{ priority: 4, text: "completed management:cancel #mg1 · state: terminated" }],
		);
		assert.deepEqual(
			workerRows(
				"mg2",
				{ action: "steer" },
				{
					mode: "management",
					results: [],
					steering: { state: "rejected" },
				},
				"failed",
			),
			[{ priority: 0, text: "failed management:steer #mg2 · state: rejected" }],
		);
		assert.deepEqual(
			workerRows("mg3", {}, { mode: "management", results: [] }, "finished"),
			[{ priority: 4, text: "completed management:action #mg3" }],
		);
	});

	it("redacts secrets and strips ANSI control characters", () => {
		const secret = "sk-live_1234567890abcdef123456";
		const rows = workerRows(
			"\x1b[31msrc1\x1b[0m",
			{ agent: "\x1b[32mdev\x1b[0m", task: `Use Bearer ${secret}` },
			{
				mode: "single",
				results: [
					{
						agent: "\x1b[32mdev\x1b[0m",
						status: "blocked",
						blocker: `api_key=${secret}`,
						messages: [{ role: "toolResult", toolName: "\x1b[33mbash\x1b[0m" }],
					},
				],
			},
			"finished",
		);
		const text = rows[0]?.text ?? "";
		assert.ok(!text.includes("\x1b"));
		assert.ok(!text.includes(secret));
		assert.ok(text.includes("blocked dev #src1/1"));
		assert.ok(text.includes("blocked by: api_key=[REDACTED]"));
		assert.ok(text.includes("Use Bearer [REDACTED]"));
		assert.ok(text.includes("last: bash"));
	});

	it("latestBatch selects the newest assistant message with subagent calls and handles missing results", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("old-a", [
				{
					type: "toolCall",
					id: "old-tc",
					name: "subagent",
					arguments: { agent: "old", task: "old task" },
				},
			]),
			makeToolResultEntry({
				id: "old-r",
				toolCallId: "old-tc",
				toolName: "subagent",
				details: { mode: "single", results: [{ agent: "old", exitCode: 0 }] },
			}),
			makeAssistantEntry("new-a", [
				{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
				{
					type: "toolCall",
					id: "tc-2",
					name: "subagent",
					arguments: { agent: "alpha", task: "First" },
				},
				{
					type: "toolCall",
					id: "tc-3",
					name: "subagent",
					arguments: { agent: "beta", task: "Second" },
				},
			]),
			makeToolResultEntry({
				id: "r-2",
				toolCallId: "tc-2",
				toolName: "subagent",
				details: { mode: "single", results: [{ agent: "alpha", exitCode: 0 }] },
			}),
			// Newer assistant message with NO subagent calls should be skipped
			makeAssistantEntry("later-a", [
				{ type: "text", text: "Wrapping up" },
				{ type: "toolCall", id: "tc-4", name: "read", arguments: { path: "README.md" } },
			]),
		];

		const rows = latestBatch(entries);
		assert.deepEqual(rows, [
			{ priority: 4, text: "completed alpha #r-2/1 · First" },
			{ priority: 1, text: "#tc-3 No worker outcome recorded." },
		]);
		assert.deepEqual(latestBatch([]), []);
	});
});

describe("worker-board extension: live events, /workers command, and TUI rendering", () => {
	it("auto-opens on live subagent start, updates on update/end, and ignores non-subagent and nested calls", () => {
		const h = createBoardHarness({ mode: "rpc" });

		// Ignored: non-subagent tool
		h.emit("tool_execution_start", {
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "ls" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(h.widgetCalls.length, 0);

		// Ignored: nested subagent (parentToolCallId set)
		h.emit("tool_execution_start", {
			toolCallId: "nested-1",
			toolName: "subagent",
			parentToolCallId: "outer-1",
			args: { agent: "inner", task: "nested" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(h.widgetCalls.length, 0);

		// Ignored: management subagent does not auto-open when closed
		h.emit("tool_execution_start", {
			toolCallId: "mgmt-1",
			toolName: "subagent",
			args: { action: "status" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(h.widgetCalls.length, 0);

		// Auto-opens on top-level non-management subagent start
		h.emit("tool_execution_start", {
			toolCallId: "sub-1",
			toolName: "subagent",
			args: { agent: "coder", task: "Implement tests" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(h.widgetCalls.length, 1);
		assert.equal(h.widgetCalls[0]?.key, "worker-board");
		assert.ok(Array.isArray(h.widgetCalls[0]?.value));
		assert.ok(h.widgetCalls[0]?.value[0]?.includes("current batch"));
		assert.ok(h.widgetCalls[0]?.value.some((l) => l.includes("#sub-1 Awaiting worker report.")));

		// Update with live details
		h.emit("tool_execution_update", {
			toolCallId: "sub-1",
			toolName: "subagent",
			partialResult: {
				details: {
					mode: "single",
					results: [
						{
							agent: "coder",
							status: "running",
							messages: [{ role: "toolResult", toolName: "edit" }],
						},
					],
				},
			},
		} satisfies Partial<ToolExecutionUpdateEvent>);
		assert.equal(h.widgetCalls.length, 2);
		const updateLines = h.widgetCalls[1]?.value;
		assert.ok(Array.isArray(updateLines));
		assert.ok(
			updateLines.includes("running coder #sub-1/1 · Implement tests · last: edit"),
		);

		// End with failure
		h.emit("tool_execution_end", {
			toolCallId: "sub-1",
			toolName: "subagent",
			isError: true,
			result: {
				details: {
					mode: "single",
					results: [{ agent: "coder", exitCode: 1 }],
				},
			},
		} satisfies Partial<ToolExecutionEndEvent>);
		assert.equal(h.widgetCalls.length, 3);
		const endLines = h.widgetCalls[2]?.value;
		assert.ok(Array.isArray(endLines));
		assert.ok(endLines.includes("failed coder #sub-1/1 · Implement tests"));
	});

	it("supports /workers display, pagination, invalid usage, hide suppression, and lifecycle refresh", async () => {
		const tasks = Array.from({ length: 8 }, (_, i) => ({
			agent: `agent-${i + 1}`,
			task: `Task ${i + 1}`,
		}));
		const results = tasks.map((t, i) => ({
			agent: t.agent,
			status: i === 7 ? "failed" : "completed",
		}));
		const branch: SessionEntry[] = [
			makeAssistantEntry("a1", [
				{ type: "toolCall", id: "tc-p", name: "subagent", arguments: { tasks } },
			]),
			makeToolResultEntry({
				id: "r-p",
				toolCallId: "tc-p",
				toolName: "subagent",
				details: { mode: "parallel", results },
			}),
		];
		const h = createBoardHarness({ branch, mode: "rpc" });

		// Invalid usage
		await h.runWorkers("0");
		await h.runWorkers("invalid");
		assert.deepEqual(h.notifications, [
			{ message: "Usage: /workers [page|hide]", level: "warning" },
			{ message: "Usage: /workers [page|hide]", level: "warning" },
		]);
		assert.equal(h.widgetCalls.length, 0);

		// Open page 1 -> failed worker sorted first!
		await h.runWorkers("");
		assert.equal(h.widgetCalls.length, 1);
		const p1 = h.widgetCalls[0]?.value;
		assert.ok(Array.isArray(p1));
		assert.equal(p1[0], "Workers · last recorded batch · 1/2");
		assert.equal(p1[1], "failed agent-8 #r-p/8 · Task 8");
		assert.equal(p1.at(-1), "/workers N: page · /workers hide: close");

		// Redrawing same page is deduplicated
		await h.runWorkers("1");
		assert.equal(h.widgetCalls.length, 1);

		// Out-of-range page warns without closing
		h.notifications.length = 0;
		await h.runWorkers("3");
		assert.deepEqual(h.notifications, [
			{ message: "Worker board has 2 page(s).", level: "warning" },
		]);

		// Page 2
		await h.runWorkers("2");
		assert.equal(h.widgetCalls.length, 2);
		const p2 = h.widgetCalls[1]?.value;
		assert.ok(Array.isArray(p2));
		assert.equal(p2[0], "Workers · last recorded batch · 2/2");

		// /workers hide closes and prevents auto-open during the same turn
		await h.runWorkers("hide");
		assert.equal(h.widgetCalls.at(-1)?.value, undefined);
		const callsAfterHide = h.widgetCalls.length;
		h.emit("tool_execution_start", {
			toolCallId: "suppressed",
			toolName: "subagent",
			args: { agent: "a", task: "t" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(h.widgetCalls.length, callsAfterHide);

		// session_tree clears live batch & resets hidden, allowing next subagent to auto-open
		h.emit("session_tree", {});
		h.emit("tool_execution_start", {
			toolCallId: "fresh",
			toolName: "subagent",
			args: { agent: "b", task: "t2" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(h.widgetCalls.length, callsAfterHide + 1);

		// turn_start clears live batch and refreshes open widget from persisted branch
		h.emit("turn_start", {});
		const afterTurnStart = h.widgetCalls.at(-1)?.value;
		assert.ok(Array.isArray(afterTurnStart));
		assert.equal(afterTurnStart[0], "Workers · last recorded batch · 1/2");

		// agent_end refreshes open widget when branch changes
		h.setBranch([]);
		h.emit("agent_end", {});
		const settledLines = h.widgetCalls.at(-1)?.value;
		assert.ok(Array.isArray(settledLines));
		assert.equal(settledLines[0], "Workers · last recorded batch · 1/1");
		assert.equal(settledLines[1], "No subagent calls on this branch.");
		assert.equal(settledLines[2], "/workers hide: close");

		// session_shutdown hides widget cleanly
		h.emit("session_shutdown", {});
		assert.equal(h.widgetCalls.at(-1)?.value, undefined);
	});

	it("enforces non-UI safety for /workers command and events", async () => {
		const h = createBoardHarness({ hasUI: false });
		await assert.rejects(
			() => h.runWorkers(""),
			{ message: "/workers requires an interactive Pi or RPC UI." },
		);
		h.emit("tool_execution_start", {
			toolCallId: "sub-no-ui",
			toolName: "subagent",
			args: { agent: "coder", task: "x" },
		} satisfies Partial<ToolExecutionStartEvent>);
		h.emit("turn_start", {});
		h.emit("session_shutdown", {});
		assert.equal(h.widgetCalls.length, 0);
		assert.equal(h.notifications.length, 0);
	});

	it("renders TUI widget within width constraints and caps each entry to two lines with ellipsis", async () => {
		const longTask = "Refactor authentication pipeline across all microservices and update every integration fixture cleanly";
		const branch: SessionEntry[] = [
			makeAssistantEntry("a1", [
				{
					type: "toolCall",
					id: "tc-1",
					name: "subagent",
					arguments: { agent: "architect", task: longTask },
				},
			]),
			makeToolResultEntry({
				id: "r-1",
				toolCallId: "tc-1",
				toolName: "subagent",
				details: {
					mode: "single",
					results: [
						{
							agent: "architect",
							status: "running",
							messages: [{ role: "toolResult", toolName: "bash" }],
						},
					],
				},
			}),
		];
		const h = createBoardHarness({ branch, mode: "tui" });
		await h.runWorkers("");
		assert.equal(h.widgetCalls.length, 1);
		const factory = h.widgetCalls[0]?.value;
		assert.equal(typeof factory, "function");
		if (typeof factory !== "function") return;
		const component = factory();
		component.invalidate();

		for (const width of [40, 20, 2, 1]) {
			const rendered = component.render(width);
			assert.ok(rendered.length > 0);
			// 3 logical lines (header, 1 worker row, footer) => at most 6 screen lines
			assert.ok(rendered.length <= 6, `width=${width} produced ${rendered.length} lines`);
			for (const line of rendered) {
				const visible = stripVTControlCharacters(line);
				assert.ok(
					visible.length <= width,
					`line "${visible}" (${visible.length}) exceeded width ${width}`,
				);
			}
		}

		// Specifically verify 2-line cap and ellipsis truncation on width=30
		const rendered30 = component.render(30);
		assert.ok(rendered30.some((line) => line.includes("…")));
	});
});
