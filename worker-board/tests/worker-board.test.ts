import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import workerBoard from "../index.ts";
import { latestBatch, workerRows } from "../report.ts";

function makeAssistantEntry(
	id: string,
	content: Array<
		| { type: "text"; text: string }
		| {
				type: "toolCall";
				id: string;
				name: string;
				arguments: Record<string, unknown>;
		  }
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
			isError: false,
			timestamp: 1,
		},
	};
}

describe("worker-board report: workerRows & latestBatch", () => {
	it("orders priorities (blocked/failed < aborted < running < pending < completed) and infers status safely", () => {
		const rows = workerRows(
			"p1",
			{
				tasks: [
					{ agent: "a1", task: "done" },
					{ agent: "a2", task: "queued" },
					{ agent: "a3", task: "live" },
					{ agent: "a4", task: "cancelled" },
					{ agent: "a5", task: "broken" },
					{ agent: "a6", task: "stuck" },
				],
			},
			{
				mode: "parallel",
				results: [
					{ agent: "a1", status: "completed" },
					{ agent: "a2", status: "pending" },
					{ agent: "a3", status: "running" },
					{ agent: "a4", status: "aborted" },
					{ agent: "a5", status: "failed", blocker: "ignored" },
					{ agent: "a6", status: "blocked", blocker: "needs schema" },
				],
			},
			"live",
		);
		assert.deepEqual(
			rows.map((r) => r.priority),
			[4, 3, 2, 1, 0, 0],
		);
		assert.ok(!rows[4]?.text.includes("blocked by:"));
		assert.ok(rows[5]?.text.includes("blocked by: needs schema"));

		// Status inference + prototype pollution guard
		assert.equal(
			workerRows(
				"s",
				{},
				{
					mode: "single",
					results: [{ agent: "w", exitCode: 0, stopReason: "error" }],
				},
				"finished",
			)[0]?.text,
			"failed w #s/1",
		);
		assert.equal(
			workerRows(
				"s",
				{},
				{ mode: "single", results: [{ agent: "w", status: "toString" }] },
				"finished",
			)[0]?.text,
			"#s/1 Unsupported worker report.",
		);
	});

	it("enforces chain prompt index safety, handles workflow/async/management modes, and redacts secrets", () => {
		const chainRows = workerRows(
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
		assert.deepEqual(chainRows, [
			{ priority: 4, text: "completed scout #ch1/1 · Find bugs" },
			{ priority: 4, text: "completed reviewer #ch1/2" },
		]);

		const wfRows = workerRows(
			"wf1",
			{ workflow: "release" },
			{
				mode: "workflow",
				results: [],
				workflow: { state: "failed", failureKind: "timeout" },
				workflowChildren: {
					children: [
						{ agent: "builder", state: "running", currentTool: "bash" },
						{ childId: "child-2", exitCode: 0 },
					],
				},
			},
			"finished",
		);
		assert.equal(wfRows[0]?.text, "#wf1 Workflow failed (timeout).");
		assert.equal(
			wfRows[1]?.text,
			"last reported running builder #wf1/1 · last: bash",
		);

		const asyncRows = workerRows(
			"ap",
			{ tasks: [{ agent: "scout", task: "Check API" }] },
			{ mode: "parallel", results: [], asyncId: "job-1" },
			"live",
		);
		assert.deepEqual(asyncRows, [
			{ priority: 2, text: "running (async) scout #ap/1 · Check API" },
		]);

		const mgmtRows = workerRows(
			"mg1",
			{ action: "cancel" },
			{
				mode: "management",
				results: [],
				lifecycleStatus: { processTerminal: { state: "terminated" } },
			},
			"finished",
		);
		assert.equal(
			mgmtRows[0]?.text,
			"completed management:cancel #mg1 · state: terminated",
		);

		const secret = "sk-live_1234567890abcdef123456";
		const sanitized = workerRows(
			"\x1b[31msrc1\x1b[0m",
			{ agent: "\x1b[32mdev\x1b[0m", task: `Bearer ${secret}` },
			{
				mode: "single",
				results: [
					{
						agent: "\x1b[32mdev\x1b[0m",
						status: "blocked",
						blocker: `api_key=${secret}`,
					},
				],
			},
			"finished",
		);
		assert.ok(!sanitized[0]?.text.includes(secret));
		assert.ok(!sanitized[0]?.text.includes("\x1b"));
		assert.ok(sanitized[0]?.text.includes("[REDACTED]"));
	});

	it("latestBatch selects the newest assistant message containing subagent calls", () => {
		const entries: SessionEntry[] = [
			makeAssistantEntry("old-a", [
				{
					type: "toolCall",
					id: "old-tc",
					name: "subagent",
					arguments: { agent: "old", task: "old" },
				},
			]),
			makeAssistantEntry("new-a", [
				{
					type: "toolCall",
					id: "tc-1",
					name: "subagent",
					arguments: { agent: "alpha", task: "First" },
				},
				{
					type: "toolCall",
					id: "tc-2",
					name: "subagent",
					arguments: { agent: "beta", task: "Second" },
				},
			]),
			makeToolResultEntry({
				id: "r-1",
				toolCallId: "tc-1",
				toolName: "subagent",
				details: { mode: "single", results: [{ agent: "alpha", exitCode: 0 }] },
			}),
			makeAssistantEntry("later-non-sub", [{ type: "text", text: "Done" }]),
		];
		assert.deepEqual(latestBatch(entries), [
			{ priority: 4, text: "completed alpha #r-1/1 · First" },
			{ priority: 1, text: "#tc-2 No worker outcome recorded." },
		]);
	});
});

describe("worker-board extension: live auto-open, /workers hide suppression & shutdown", () => {
	it("auto-opens on top-level subagent start, suppresses after /workers hide, and clears on shutdown", async () => {
		const handlers = new Map<
			string,
			Array<(event: unknown, ctx: ExtensionContext) => void>
		>();
		let cmdHandler:
			| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
			| undefined;

		workerBoard({
			on(
				event: string,
				fn: (event: unknown, ctx: ExtensionContext) => void,
			): () => void {
				handlers.set(event, [...(handlers.get(event) ?? []), fn]);
				return () => {};
			},
			registerCommand(
				name: string,
				cfg: {
					handler: (
						args: string,
						ctx: ExtensionCommandContext,
					) => Promise<void>;
				},
			): void {
				if (name === "workers") cmdHandler = cfg.handler;
			},
		} as unknown as ExtensionAPI);

		const widgetCalls: Array<string[] | (() => Component) | undefined> = [];
		const ctx = {
			hasUI: true,
			mode: "rpc",
			sessionManager: { getBranch: () => [] },
			ui: {
				notify(): void {},
				setWidget(_k: string, val: string[] | (() => Component) | undefined) {
					widgetCalls.push(val);
				},
			},
		} as unknown as ExtensionContext;

		const emit = (name: string, event: unknown) => {
			for (const fn of handlers.get(name) ?? []) fn(event, ctx);
		};

		// Nested subagent ignored
		emit("tool_execution_start", {
			toolCallId: "nested",
			toolName: "subagent",
			parentToolCallId: "outer",
			args: { agent: "inner", task: "x" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(widgetCalls.length, 0);

		// Top-level subagent auto-opens
		emit("tool_execution_start", {
			toolCallId: "sub-1",
			toolName: "subagent",
			args: { agent: "coder", task: "Build" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(widgetCalls.length, 1);
		assert.ok(Array.isArray(widgetCalls[0]));

		emit("tool_execution_end", {
			toolCallId: "sub-1",
			toolName: "subagent",
			isError: false,
			result: {
				details: { mode: "single", results: [{ agent: "coder", exitCode: 0 }] },
			},
		} satisfies Partial<ToolExecutionEndEvent>);
		assert.equal(widgetCalls.length, 2);

		// /workers hide closes and suppresses subsequent auto-open in same turn
		await cmdHandler?.("hide", ctx as unknown as ExtensionCommandContext);
		assert.equal(widgetCalls.at(-1), undefined);
		const countAfterHide = widgetCalls.length;
		emit("tool_execution_start", {
			toolCallId: "sub-2",
			toolName: "subagent",
			args: { agent: "coder", task: "Suppressed" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.equal(widgetCalls.length, countAfterHide);

		// session_tree resets suppression; session_shutdown hides cleanly
		emit("session_tree", {});
		emit("tool_execution_start", {
			toolCallId: "sub-3",
			toolName: "subagent",
			args: { agent: "coder", task: "Reopened" },
		} satisfies Partial<ToolExecutionStartEvent>);
		assert.ok(Array.isArray(widgetCalls.at(-1)));
		emit("session_shutdown", {});
		assert.equal(widgetCalls.at(-1), undefined);
	});
});
