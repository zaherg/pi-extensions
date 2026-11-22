import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import rtkGain from "../index.ts";

interface ExecCall {
	command: string;
	args: string[];
	cwd: string | undefined;
	signal: AbortSignal | undefined;
	timeout: number | undefined;
	maxBuffer: number | undefined;
}

interface ExecOptions {
	cwd?: string;
	signal?: AbortSignal;
	timeout?: number;
	maxBuffer?: number;
}

type ExecHandler = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

interface StatusRecord {
	key: string;
	value: string | undefined;
}

interface NotifyRecord {
	message: string;
	level: string | undefined;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeExecResult(opts?: Partial<ExecResult>): ExecResult {
	return {
		stdout: opts?.stdout ?? "",
		stderr: opts?.stderr ?? "",
		code: opts?.code ?? 0,
		killed: opts?.killed ?? false,
		truncated: opts?.truncated ?? false,
	};
}

function okExec(stdout: string): ExecResult {
	return makeExecResult({ stdout });
}

function gainJson(summary: {
	total_commands: number;
	total_input: number;
	total_output: number;
	total_saved: number;
}): string {
	return JSON.stringify({ summary });
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
	}
}

function createRtkHarness(execHandler: ExecHandler) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	let commandHandler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	const execCalls: ExecCall[] = [];

	const api = {
		on(event: string, fn: (event: unknown, ctx: ExtensionContext) => unknown): () => void {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(
			name: string,
			config: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		): void {
			if (name === "rtk-gain") commandHandler = config.handler;
		},
		async exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
			execCalls.push({
				command,
				args: [...args],
				cwd: options?.cwd,
				signal: options?.signal,
				timeout: options?.timeout,
				maxBuffer: options?.maxBuffer,
			});
			return execHandler(command, args, options);
		},
	};

	rtkGain(api as unknown as ExtensionAPI);
	assert.ok(commandHandler, "rtk-gain command should be registered");

	const statuses: StatusRecord[] = [];
	const notifications: NotifyRecord[] = [];
	let onSetStatus: ((key: string, value: string | undefined) => void) | undefined;

	const makeContext = (opts?: { hasUI?: boolean; cwd?: string }): ExtensionContext =>
		({
			hasUI: opts?.hasUI ?? true,
			cwd: opts?.cwd ?? "/workspace",
			ui: {
				setStatus(key: string, value: string | undefined): void {
					statuses.push({ key, value });
					onSetStatus?.(key, value);
				},
				notify(message: string, level?: string): void {
					notifications.push({ message, level });
				},
			},
		}) as unknown as ExtensionContext;

	return {
		execCalls,
		statuses,
		notifications,
		setOnSetStatus(fn: ((key: string, value: string | undefined) => void) | undefined): void {
			onSetStatus = fn;
		},
		makeContext,
		async emit(
			eventName: "session_start" | "turn_end" | "agent_settled" | "session_shutdown",
			event: unknown,
			ctx?: ExtensionContext,
		): Promise<void> {
			const context = ctx ?? makeContext();
			for (const fn of handlers.get(eventName) ?? []) {
				await fn(event, context);
			}
		},
		async runCommand(args = "", ctx?: ExtensionContext): Promise<void> {
			assert.ok(commandHandler);
			const context = (ctx ?? makeContext()) as unknown as ExtensionCommandContext;
			await commandHandler(args, context);
		},
	};
}

describe("rtk-gain: happy paths", () => {
	it("updates status bar on session_start, turn_end (with toolResults only), and agent_settled", async () => {
		let callCount = 0;
		const h = createRtkHarness(async () => {
			callCount++;
			if (callCount === 1) {
				return okExec(
					gainJson({ total_commands: 10, total_input: 2500, total_output: 1000, total_saved: 1500 }),
				);
			}
			if (callCount === 2) {
				return okExec(
					gainJson({ total_commands: 1, total_input: 2, total_output: 1, total_saved: 1 }),
				);
			}
			return okExec(
				gainJson({ total_commands: 0, total_input: 0, total_output: 0, total_saved: 0 }),
			);
		});

		await h.emit("session_start", {});
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 1);
		assert.deepEqual(h.execCalls[0]?.args, ["gain", "--format", "json"]);
		assert.equal(h.execCalls[0]?.cwd, "/workspace");
		assert.equal(h.execCalls[0]?.timeout, 5_000);
		assert.equal(h.execCalls[0]?.maxBuffer, 1024 * 1024);
		assert.deepEqual(h.statuses.at(-1), {
			key: "rtk-gain",
			value: "RTK: 1.5K tokens saved (60.0%)",
		});

		// turn_end with empty toolResults does NOT refresh
		await h.emit("turn_end", { toolResults: [] });
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 1);

		// turn_end with toolResults refreshes (singular 1 token)
		await h.emit("turn_end", { toolResults: [{ id: "1" }] });
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 2);
		assert.deepEqual(h.statuses.at(-1), {
			key: "rtk-gain",
			value: "RTK: 1 token saved (50.0%)",
		});

		// agent_settled refreshes (zero input -> 0.0%)
		await h.emit("agent_settled", {});
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 3);
		assert.deepEqual(h.statuses.at(-1), {
			key: "rtk-gain",
			value: "RTK: 0 tokens saved (0.0%)",
		});
	});

	it("/rtk-gain reports exact local counts with singular/plural grammar", async () => {
		const h = createRtkHarness(async () =>
			okExec(
				gainJson({
					total_commands: 1,
					total_input: 1200,
					total_output: 200,
					total_saved: 1000,
				}),
			),
		);

		await h.runCommand("");
		assert.deepEqual(h.notifications, [
			{
				level: "info",
				message:
					"Local RTK gain: 1,000 tokens saved (83.3%)\n  1 command | 1,200 tokens before / 200 after",
			},
		]);
		assert.deepEqual(h.statuses.at(-1), {
			key: "rtk-gain",
			value: "RTK: 1K tokens saved (83.3%)",
		});
	});

	it("/rtk-gain all aggregates host + running sandboxes and skips stopped/non-running sandboxes", async () => {
		const h = createRtkHarness(async (command, args) => {
			if (command.endsWith("rtk")) {
				return okExec(
					gainJson({ total_commands: 10, total_input: 1000, total_output: 400, total_saved: 600 }),
				);
			}
			if (args[1] === "ls") {
				return okExec(
					JSON.stringify([
						{ name: "box-a", status: "running" },
						{ name: "box-b", status: "stopped" },
						{ name: "box-c", status: "paused" },
					]),
				);
			}
			if (args[1] === "exec" && args[3] === "box-a") {
				return okExec(
					gainJson({ total_commands: 5, total_input: 500, total_output: 100, total_saved: 400 }),
				);
			}
			throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
		});

		await h.runCommand("all");
		// Verify sbx exec was NEVER invoked for stopped/paused sandboxes
		const sbxExecTargets = h.execCalls
			.filter((c) => c.args[1] === "exec")
			.map((c) => c.args[3]);
		assert.deepEqual(sbxExecTargets, ["box-a"]);

		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0]?.level, "warning");
		const text = h.notifications[0]?.message ?? "";
		assert.ok(text.startsWith("Total (reported only): 1,000 tokens saved (66.7%)"));
		assert.ok(text.includes("15 commands | 1,500 tokens before / 500 after"));
		assert.ok(text.includes("Local: 600 tokens saved (60.0%)"));
		assert.ok(text.includes("Sandbox box-a: 400 tokens saved (80.0%)"));
		assert.ok(text.includes("Sandbox box-b: excluded (stopped)"));
		assert.ok(text.includes("Sandbox box-c: excluded (not running)"));
	});

	it("/rtk-gain all reports complete Total (info) when all sandboxes are running and succeed", async () => {
		const h = createRtkHarness(async (command, args) => {
			if (command.endsWith("rtk")) {
				return okExec(
					gainJson({ total_commands: 2, total_input: 200, total_output: 100, total_saved: 100 }),
				);
			}
			if (args[1] === "ls") {
				return okExec(JSON.stringify([{ name: "dev.1-ok", status: "running" }]));
			}
			return okExec(
				gainJson({ total_commands: 3, total_input: 300, total_output: 150, total_saved: 150 }),
			);
		});

		await h.runCommand("all");
		assert.equal(h.notifications[0]?.level, "info");
		assert.ok(h.notifications[0]?.message.startsWith("Total: 250 tokens saved (50.0%)"));
	});

	it("/rtk-gain all handles empty array and null from sbx ls --json", async () => {
		for (const sbxPayload of ["[]", "null"]) {
			const h = createRtkHarness(async (command) => {
				if (command.endsWith("rtk")) {
					return okExec(
						gainJson({ total_commands: 2, total_input: 100, total_output: 50, total_saved: 50 }),
					);
				}
				return okExec(sbxPayload);
			});

			await h.runCommand("all");
			assert.equal(h.notifications[0]?.level, "info");
			const text = h.notifications[0]?.message ?? "";
			assert.ok(!text.includes("Total:"));
			assert.ok(text.includes("Local: 50 tokens saved (50.0%)"));
			assert.ok(text.endsWith("Sandboxes: none"));
		}
	});
});

describe("rtk-gain: command validation, exec errors, and schema validation", () => {
	it("rejects invalid arguments without invoking exec", async () => {
		const h = createRtkHarness(async () => okExec("{}"));
		await h.runCommand("bad");
		assert.equal(h.execCalls.length, 0);
		assert.deepEqual(h.notifications, [{ message: "Usage: /rtk-gain [all]", level: "error" }]);
	});

	it("handles ENOENT stderr, exec rejection, non-zero exit, killed, truncated, invalid JSON, and invalid schema", async () => {
		const cases: Array<{ name: string; exec: ExecHandler; expectedReason: string }> = [
			{
				name: "ENOENT stderr",
				exec: async () => makeExecResult({ stderr: "spawn rtk ENOENT", code: 1 }),
				expectedReason: "rtk not found",
			},
			{
				name: "exec throws",
				exec: async () => {
					throw new Error("spawn failure");
				},
				expectedReason: "could not run rtk",
			},
			{
				name: "non-zero exit",
				exec: async () => makeExecResult({ stderr: "permission denied", code: 2 }),
				expectedReason: "rtk exited with code 2",
			},
			{
				name: "killed / timed out",
				exec: async () => makeExecResult({ killed: true }),
				expectedReason: "rtk was interrupted or timed out",
			},
			{
				name: "truncated > 1 MiB",
				exec: async () => makeExecResult({ stdout: "{}", truncated: true }),
				expectedReason: "rtk output exceeded 1 MiB",
			},
			{
				name: "invalid JSON",
				exec: async () => okExec("{not json"),
				expectedReason: "rtk returned invalid JSON",
			},
			{
				name: "total_saved > total_input",
				exec: async () =>
					okExec(
						gainJson({ total_commands: 1, total_input: 100, total_output: 0, total_saved: 101 }),
					),
				expectedReason: "rtk returned an unexpected report format",
			},
			{
				name: "negative counter",
				exec: async () =>
					okExec(
						gainJson({ total_commands: -1, total_input: 100, total_output: 50, total_saved: 50 }),
					),
				expectedReason: "rtk returned an unexpected report format",
			},
			{
				name: "float counter",
				exec: async () =>
					okExec(
						gainJson({ total_commands: 1.5, total_input: 100, total_output: 50, total_saved: 50 }),
					),
				expectedReason: "rtk returned an unexpected report format",
			},
			{
				name: "unsafe integer counter",
				exec: async () =>
					okExec(
						JSON.stringify({
							summary: {
								total_commands: 1,
								total_input: Number.MAX_SAFE_INTEGER + 2,
								total_output: 0,
								total_saved: 0,
							},
						}),
					),
				expectedReason: "rtk returned an unexpected report format",
			},
		];

		for (const c of cases) {
			const h = createRtkHarness(c.exec);
			await h.runCommand("");
			assert.deepEqual(
				h.notifications,
				[
					{
						level: "error",
						message: `Local RTK gain unavailable: ${c.expectedReason}. Check rtk gain --format json.`,
					},
				],
				`case failed: ${c.name}`,
			);
			// Status bar is cleared on error
			assert.deepEqual(h.statuses.at(-1), { key: "rtk-gain", value: undefined });
		}
	});

	it("reports rtk not found when missing on Windows PATH without calling exec", async () => {
		const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const origPath = process.env.PATH;
		try {
			Object.defineProperty(process, "platform", {
				value: "win32",
				configurable: true,
			});
			process.env.PATH = "";
			const h = createRtkHarness(async () => {
				throw new Error("should not call exec");
			});
			await h.runCommand("");
			assert.equal(h.execCalls.length, 0);
			assert.deepEqual(h.notifications, [
				{
					level: "error",
					message: "Local RTK gain unavailable: rtk not found. Check rtk gain --format json.",
				},
			]);
		} finally {
			if (origDescriptor) {
				Object.defineProperty(process, "platform", origDescriptor);
			}
			if (origPath === undefined) delete process.env.PATH;
			else process.env.PATH = origPath;
		}
	});

	it("reports safe integer overflow when aggregating host + sandbox totals", async () => {
		const big = Number.MAX_SAFE_INTEGER - 10;
		const h = createRtkHarness(async (command, args) => {
			if (command.endsWith("rtk")) {
				return okExec(
					gainJson({ total_commands: 1, total_input: big, total_output: 0, total_saved: big }),
				);
			}
			if (args[1] === "ls") {
				return okExec(JSON.stringify([{ name: "bigbox", status: "running" }]));
			}
			return okExec(
				gainJson({ total_commands: 1, total_input: 100, total_output: 0, total_saved: 100 }),
			);
		});

		await h.runCommand("all");
		assert.equal(h.notifications[0]?.level, "warning");
		const text = h.notifications[0]?.message ?? "";
		assert.ok(text.startsWith("Total unavailable: counters exceed safe integer range."));
		assert.ok(text.includes("Local:"));
		assert.ok(text.includes("Sandbox bigbox:"));
	});
});

describe("rtk-gain: sandbox validation, guest exit codes, and partial failures", () => {
	it("excludes Sandboxes with helpful message when sbx is missing", async () => {
		const h = createRtkHarness(async (command) => {
			if (command.endsWith("rtk")) {
				return okExec(
					gainJson({ total_commands: 1, total_input: 100, total_output: 50, total_saved: 50 }),
				);
			}
			return makeExecResult({ stderr: "spawn sbx ENOENT", code: 1 });
		});
		await h.runCommand("all");
		assert.equal(h.notifications[0]?.level, "warning");
		const text = h.notifications[0]?.message ?? "";
		assert.ok(text.startsWith("Total (reported only):"));
		assert.ok(
			text.includes("Sandboxes: excluded (sbx not found; check sbx ls --json on the host)"),
		);
	});

	it("rejects invalid sandbox names, missing statuses, non-arrays, and duplicate sandbox names", async () => {
		const badPayloads = [
			JSON.stringify({ not: "an-array" }),
			JSON.stringify([{ name: "../escape", status: "running" }]),
			JSON.stringify([{ name: "-leading-dash", status: "running" }]),
			JSON.stringify([{ name: "a".repeat(64), status: "running" }]),
			JSON.stringify([{ name: "ok", status: "" }]),
			JSON.stringify([
				{ name: "dup", status: "running" },
				{ name: "dup", status: "stopped" },
			]),
		];
		for (const payload of badPayloads) {
			const h = createRtkHarness(async (command) => {
				if (command.endsWith("rtk")) {
					return okExec(
						gainJson({ total_commands: 1, total_input: 100, total_output: 50, total_saved: 50 }),
					);
				}
				return okExec(payload);
			});
			await h.runCommand("all");
			assert.equal(h.notifications[0]?.level, "warning");
			const text = h.notifications[0]?.message ?? "";
			assert.ok(text.startsWith("Total (reported only):"));
			assert.ok(
				text.includes(
					"Sandboxes: excluded (sbx returned an unexpected report format; check sbx ls --json on the host)",
				),
				`unexpected text for payload ${payload}: ${text}`,
			);
		}
	});

	it("maps guest exit codes 127, 125, and other codes accurately and reports all-failed error", async () => {
		const h = createRtkHarness(async (command, args) => {
			if (command.endsWith("rtk")) {
				return makeExecResult({ stderr: "spawn rtk ENOENT", code: 1 });
			}
			if (args[1] === "ls") {
				return okExec(
					JSON.stringify([
						{ name: "g127", status: "running" },
						{ name: "g125", status: "running" },
						{ name: "g42", status: "running" },
					]),
				);
			}
			const name = args[3];
			if (name === "g127") return makeExecResult({ code: 127 });
			if (name === "g125") return makeExecResult({ code: 125 });
			return makeExecResult({ code: 42 });
		});

		await h.runCommand("all");
		assert.equal(h.notifications[0]?.level, "error");
		const text = h.notifications[0]?.message ?? "";
		assert.ok(text.startsWith("No RTK gains available."));
		assert.ok(text.includes("Local: excluded (rtk not found)"));
		assert.ok(text.includes("Sandbox g127: excluded (rtk not found in sandbox)"));
		assert.ok(text.includes("Sandbox g125: excluded (sbx could not run rtk)"));
		assert.ok(text.includes("Sandbox g42: excluded (rtk exited with code 42)"));
	});

	it("reports warning with Total (reported only) when host fails but a sandbox succeeds", async () => {
		const h = createRtkHarness(async (command, args) => {
			if (command.endsWith("rtk")) {
				return makeExecResult({ stderr: "spawn rtk ENOENT", code: 1 });
			}
			if (args[1] === "ls") {
				return okExec(JSON.stringify([{ name: "ok-box", status: "running" }]));
			}
			return okExec(
				gainJson({ total_commands: 4, total_input: 400, total_output: 100, total_saved: 300 }),
			);
		});

		await h.runCommand("all");
		assert.equal(h.notifications[0]?.level, "warning");
		const text = h.notifications[0]?.message ?? "";
		assert.ok(text.startsWith("Total (reported only): 300 tokens saved (75.0%)"));
		assert.ok(text.includes("Local: excluded (rtk not found)"));
		assert.ok(text.includes("Sandbox ok-box: 300 tokens saved (75.0%)"));
	});

	it("reports error when host fails and sbx ls --json returns empty", async () => {
		const h = createRtkHarness(async (command) => {
			if (command.endsWith("rtk")) {
				return makeExecResult({ stderr: "spawn rtk ENOENT", code: 1 });
			}
			return okExec("[]");
		});

		await h.runCommand("all");
		assert.equal(h.notifications[0]?.level, "error");
		assert.equal(
			h.notifications[0]?.message,
			"No RTK gains available.\nLocal: excluded (rtk not found)\nSandboxes: none",
		);
	});
});

describe("rtk-gain: coalescing, race guard, lifecycle aborts, and non-UI stderr", () => {
	it("coalesces multiple queued refreshes into one follow-up using the latest context", async () => {
		const d1 = deferred<ExecResult>();
		const d2 = deferred<ExecResult>();
		let n = 0;
		const h = createRtkHarness(() => {
			n++;
			return n === 1 ? d1.promise : d2.promise;
		});

		const ctx1 = h.makeContext({ cwd: "/dir-1" });
		const ctx2 = h.makeContext({ cwd: "/dir-2" });
		const ctx3 = h.makeContext({ cwd: "/dir-3" });

		await h.emit("session_start", {}, ctx1);
		assert.equal(h.execCalls.length, 1);

		// Multiple refreshes while 1st is in flight should coalesce to ctx3
		await h.emit("turn_end", { toolResults: [{}] }, ctx2);
		await h.emit("agent_settled", {}, ctx3);
		assert.equal(h.execCalls.length, 1);

		d1.resolve(
			okExec(gainJson({ total_commands: 1, total_input: 100, total_output: 50, total_saved: 50 })),
		);
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 2);
		assert.equal(h.execCalls[1]?.cwd, "/dir-3");

		d2.resolve(
			okExec(gainJson({ total_commands: 2, total_input: 200, total_output: 50, total_saved: 150 })),
		);
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 2);
		assert.deepEqual(h.statuses.at(-1), {
			key: "rtk-gain",
			value: "RTK: 150 tokens saved (75.0%)",
		});
	});

	it("preserves newer pending promise via pending === next race guard and serializes freshLocal reads", async () => {
		const d1 = deferred<ExecResult>();
		const d2 = deferred<ExecResult>();
		const d3 = deferred<ExecResult>();
		let n = 0;
		const h = createRtkHarness(() => {
			n++;
			if (n === 1) return d1.promise;
			if (n === 2) return d2.promise;
			return d3.promise;
		});

		const ctx = h.makeContext();
		let triggered = false;
		h.setOnSetStatus(() => {
			if (!triggered) {
				triggered = true;
				void h.emit("session_start", {}, ctx);
			}
		});

		await h.emit("session_start", {}, ctx);
		assert.equal(h.execCalls.length, 1);
		d1.resolve(
			okExec(gainJson({ total_commands: 1, total_input: 100, total_output: 50, total_saved: 50 })),
		);
		await flushMicrotasks();
		// Re-entrant session_start queued ctx while d1 was pending, so d1's finally started d2
		assert.equal(h.execCalls.length, 2);

		// Calling /rtk-gain while d2 is in flight waits for d2, then runs d3 for fresh data
		const cmdPromise = h.runCommand("", ctx);
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 2);

		d2.resolve(
			okExec(gainJson({ total_commands: 2, total_input: 200, total_output: 100, total_saved: 100 })),
		);
		await flushMicrotasks();
		assert.equal(h.execCalls.length, 3);

		d3.resolve(
			okExec(gainJson({ total_commands: 3, total_input: 300, total_output: 60, total_saved: 240 })),
		);
		await cmdPromise;
		assert.ok(h.notifications[0]?.message.includes("240 tokens saved (80.0%)"));
	});

	it("handles session_shutdown -> session_start lifecycle and prior-signal abort cleanly", async () => {
		const d1 = deferred<ExecResult>();
		const d2 = deferred<ExecResult>();
		let n = 0;
		const h = createRtkHarness(() => {
			n++;
			return n === 1 ? d1.promise : d2.promise;
		});

		const ctx = h.makeContext();
		await h.emit("session_start", {}, ctx);
		const signal1 = h.execCalls[0]?.signal;
		assert.ok(signal1);
		assert.equal(signal1.aborted, false);

		// Start session_shutdown while d1 is still pending
		const shutdownPromise = h.emit("session_shutdown", {}, ctx);
		assert.equal(signal1.aborted, true);
		assert.deepEqual(h.statuses.at(-1), { key: "rtk-gain", value: undefined });

		// Resolving aborted d1 must NOT overwrite cleared status
		d1.resolve(
			okExec(gainJson({ total_commands: 9, total_input: 900, total_output: 100, total_saved: 800 })),
		);
		await shutdownPromise;
		assert.deepEqual(h.statuses.at(-1), { key: "rtk-gain", value: undefined });

		// session_start recreates AbortController and refreshes cleanly
		await h.emit("session_start", {}, ctx);
		const signal2 = h.execCalls[1]?.signal;
		assert.ok(signal2);
		assert.equal(signal2.aborted, false);
		d2.resolve(
			okExec(gainJson({ total_commands: 2, total_input: 100, total_output: 20, total_saved: 80 })),
		);
		await flushMicrotasks();
		assert.deepEqual(h.statuses.at(-1), {
			key: "rtk-gain",
			value: "RTK: 80 tokens saved (80.0%)",
		});
	});

	it("suppresses /rtk-gain notification if aborted while in flight", async () => {
		const d1 = deferred<ExecResult>();
		const h = createRtkHarness(() => d1.promise);
		const ctx = h.makeContext();
		const cmd = h.runCommand("", ctx);
		await flushMicrotasks();

		const shutdown = h.emit("session_shutdown", {}, ctx);
		d1.resolve(
			okExec(gainJson({ total_commands: 1, total_input: 100, total_output: 50, total_saved: 50 })),
		);
		await Promise.all([cmd, shutdown]);
		assert.equal(h.notifications.length, 0);
	});

	it("writes command output to process.stderr and skips status refreshes when !ctx.hasUI", async () => {
		const h = createRtkHarness(async () =>
			okExec(gainJson({ total_commands: 2, total_input: 100, total_output: 40, total_saved: 60 })),
		);
		const noUiCtx = h.makeContext({ hasUI: false });

		await h.emit("session_start", {}, noUiCtx);
		await h.emit("turn_end", { toolResults: [{}] }, noUiCtx);
		await h.emit("agent_settled", {}, noUiCtx);
		assert.equal(h.execCalls.length, 0);
		assert.equal(h.statuses.length, 0);

		const chunks: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stderr.write;
		try {
			await h.runCommand("", noUiCtx);
			await h.runCommand("bad", noUiCtx);
		} finally {
			process.stderr.write = originalWrite;
		}
		assert.equal(h.notifications.length, 0);
		assert.equal(chunks.length, 2);
		assert.equal(
			chunks[0],
			"Local RTK gain: 60 tokens saved (60.0%)\n  2 commands | 100 tokens before / 40 after\n",
		);
		assert.equal(chunks[1], "Usage: /rtk-gain [all]\n");
	});

	it("does not reject when ctx.hasUI getter throws after session disposal mid-refresh", async () => {
		const d1 = deferred<ExecResult>();
		const h = createRtkHarness(() => d1.promise);
		let stale = false;
		const baseCtx = h.makeContext({ hasUI: true });
		const guardedCtx = new Proxy(baseCtx, {
			get(target, prop, receiver) {
				if (stale && (prop === "hasUI" || prop === "ui" || prop === "cwd")) {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		await h.emit("session_start", {}, guardedCtx);
		await flushMicrotasks();
		stale = true;
		d1.resolve(
			okExec(gainJson({ total_commands: 1, total_input: 100, total_output: 40, total_saved: 60 })),
		);
		await flushMicrotasks();
		assert.equal(h.statuses.length, 0);
	});
});
