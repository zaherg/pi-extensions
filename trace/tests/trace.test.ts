import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import trace, { callPreview, codemodeCalls } from "../index.ts";

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
	toolCallId: string;
	toolName: string;
	text?: string;
	content?: ToolResultMessage["content"];
	details?: unknown;
	isError?: boolean;
}): SessionEntry {
	return {
		type: "message",
		id: opts.id,
		parentId: null,
		timestamp: "2026-11-22T10:00:01Z",
		message: makeToolResultMessage(opts),
	};
}

function createTraceHarness(branch: SessionEntry[]) {
	let commandHandler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	trace({
		on: () => () => {},
		registerCommand(
			name: string,
			cfg: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		): void {
			if (name === "trace") commandHandler = cfg.handler;
		},
	} as unknown as ExtensionAPI);
	assert.ok(commandHandler);

	const notifications: Array<{ message: string; level: string | undefined }> =
		[];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	let pickFirst = true;

	return {
		notifications,
		selectCalls,
		async run(args = "", selectFirst = true): Promise<void> {
			pickFirst = selectFirst;
			await commandHandler?.(args, {
				hasUI: true,
				sessionManager: { getBranch: () => branch },
				ui: {
					notify(message: string, level?: string): void {
						notifications.push({ message, level });
					},
					async select(
						title: string,
						options: string[],
					): Promise<string | undefined> {
						selectCalls.push({ title, options: [...options] });
						if (pickFirst) {
							pickFirst = false;
							return options[0];
						}
						return undefined;
					},
				},
			} as unknown as ExtensionCommandContext);
		},
	};
}

describe("trace: callPreview & codemodeCalls", () => {
	it("extracts preview keys in precedence order, skips // @options: lines, truncates, and redacts secrets", () => {
		assert.equal(callPreview(null), "");
		assert.equal(
			callPreview({
				command: 123,
				path: "   \x1b[31m\x1b[0m  ",
				file_path: "picked.ts",
				workflow: "later",
			}),
			"picked.ts",
		);
		assert.equal(
			callPreview({
				code: "\r\n // @options: {\"timeout\":5000}\n  const x = await read('a.ts');\nconsole.log(x);",
			}),
			"const x = await read('a.ts');",
		);
		assert.equal(callPreview({ command: `echo ${"a".repeat(60)}` }).length, 40);
		assert.equal(
			callPreview({ url: "https://user:pass@api.test/v1" }),
			"https://[REDACTED]@api.test/v1",
		);
	});

	it("parses codemode nested calls, skips malformed items, and redacts ANSI-wrapped secrets", () => {
		const msg = makeToolResultMessage({
			toolCallId: "c1",
			toolName: "codemode",
			details: {
				calls: [
					null,
					{ name: "", status: "ok" },
					{ name: "bash", args: "ls -la", status: "ok", error: "" },
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
			{
				name: "curl",
				args: "Bearer [REDACTED]",
				status: "error",
				error: "api_key=[REDACTED]",
			},
		]);
	});
});

describe("trace: codemode filtering, nested-call prioritization & 16 KiB tail slicing", () => {
	it("computes per-tool codemode badges and prioritizes <tool> failed -> <tool> ok -> unrelated failed -> recent", async () => {
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
			makeAssistantEntry("a1", [
				{ id: "cm", name: "codemode", arguments: { code: "await run();" } },
			]),
			makeToolResultEntry({
				id: "r1",
				toolCallId: "cm",
				toolName: "codemode",
				text: "done",
				details: { calls },
			}),
		]);

		await h.run("bash", true);
		assert.ok(
			h.selectCalls[0]?.options[0]?.startsWith(
				"1. nested-err codemode ([bash 2/4 err] await run();)",
			),
		);
		const msg = h.notifications[0]?.message ?? "";
		assert.ok(msg.includes("(Showing 10 of 15; errors/matches prioritized)"));
		const indices = [...msg.matchAll(/^- #(\d+) /gm)].map((m) => Number(m[1]));
		assert.deepEqual(indices, [1, 2, 3, 4, 5, 11, 12, 13, 14, 15]);
	});

	it("assembles bounded 16 KiB backward tail across blocks and drops mid-line cuts", async () => {
		const earlier = `DROPPED_SECRET_PART\nKEPT_EARLIER\n${"x".repeat(16_370)}`;
		const h = createTraceHarness([
			makeToolResultEntry({
				id: "r-mid",
				toolCallId: "t-mid",
				toolName: "bash",
				content: [
					{ type: "text", text: "SKIPPED_TOO_OLD" },
					{ type: "text", text: earlier },
					{ type: "text", text: "FINAL_LINE" },
				],
			}),
		]);

		await h.run("", true);
		const out = h.notifications[0]?.message ?? "";
		assert.ok(out.includes("[Last output only]"));
		assert.ok(!out.includes("DROPPED_SECRET_PART"));
		assert.ok(out.includes("FINAL_LINE"));
	});
});
