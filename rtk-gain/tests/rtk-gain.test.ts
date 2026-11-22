import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import rtkGain from "../index.ts";

function makeExec(
	stdout = "",
	overrides: Partial<ExecResult> = {},
): ExecResult {
	return {
		stdout,
		stderr: overrides.stderr ?? "",
		code: overrides.code ?? 0,
		killed: overrides.killed ?? false,
		truncated: overrides.truncated ?? false,
	};
}

function gainJson(
	total_commands: number,
	total_input: number,
	total_output: number,
	total_saved: number,
): string {
	return JSON.stringify({
		summary: { total_commands, total_input, total_output, total_saved },
	});
}

function createHarness(
	execHandler: (command: string, args: string[]) => Promise<ExecResult>,
) {
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: ExtensionContext) => unknown>
	>();
	let commandHandler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; level: string | undefined }> =
		[];

	rtkGain({
		on(event: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			return () => {};
		},
		registerCommand(
			name: string,
			cfg: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) {
			if (name === "rtk-gain") commandHandler = cfg.handler;
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args: [...args] });
			return execHandler(command, args);
		},
	} as unknown as ExtensionAPI);

	const ctx = {
		hasUI: true,
		cwd: "/workspace",
		ui: {
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionCommandContext;

	return {
		execCalls,
		statuses,
		notifications,
		async emit(event: string, payload: unknown = {}) {
			for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
			for (let i = 0; i < 5; i++) await Promise.resolve();
		},
		async run(args = "") {
			assert.ok(commandHandler);
			await commandHandler(args, ctx);
		},
	};
}

describe("rtk-gain", () => {
	it("parses local rtk gain JSON, updates status bar on tool turns, and rejects malformed output", async () => {
		const ok = createHarness(async () =>
			makeExec(gainJson(10, 2500, 1000, 1500)),
		);
		await ok.emit("session_start");
		assert.equal(ok.statuses.at(-1), "RTK: 1.5K tokens saved (60.0%)");

		// turn_end without toolResults skips exec
		await ok.emit("turn_end", { toolResults: [] });
		assert.equal(ok.execCalls.length, 1);

		await ok.run("");
		assert.equal(ok.notifications[0]?.level, "info");
		assert.match(
			ok.notifications[0]?.message ?? "",
			/Local RTK gain: 1,500 tokens saved \(60\.0%\)/,
		);

		// Rejects invalid schema (total_saved > total_input) and clears status bar
		const bad = createHarness(async () => makeExec(gainJson(1, 100, 0, 101)));
		await bad.run("");
		assert.equal(bad.notifications[0]?.level, "error");
		assert.equal(bad.statuses.at(-1), undefined);
	});

	it("aggregates host + running sandboxes in /rtk-gain all and skips stopped or invalid sandboxes", async () => {
		const h = createHarness(async (command, args) => {
			if (command.endsWith("rtk"))
				return makeExec(gainJson(10, 1000, 400, 600));
			if (args[1] === "ls") {
				return makeExec(
					JSON.stringify([
						{ name: "box-a", status: "running" },
						{ name: "box-b", status: "stopped" },
					]),
				);
			}
			if (args[1] === "exec" && args[3] === "box-a") {
				return makeExec(gainJson(5, 500, 100, 400));
			}
			throw new Error(`unexpected: ${command} ${args.join(" ")}`);
		});

		await h.run("all");
		assert.deepEqual(
			h.execCalls.filter((c) => c.args[1] === "exec").map((c) => c.args[3]),
			["box-a"],
		);
		const msg = h.notifications[0]?.message ?? "";
		assert.match(msg, /Total \(reported only\): 1,000 tokens saved \(66\.7%\)/);
		assert.match(msg, /Sandbox box-a: 400 tokens saved \(80\.0%\)/);
		assert.match(msg, /Sandbox box-b: excluded \(stopped\)/);

		// Rejects unsafe sandbox names (path traversal) without running sbx exec
		const unsafe = createHarness(async (command) => {
			if (command.endsWith("rtk")) return makeExec(gainJson(1, 100, 50, 50));
			return makeExec(
				JSON.stringify([{ name: "../escape", status: "running" }]),
			);
		});
		await unsafe.run("all");
		assert.equal(
			unsafe.execCalls.some((c) => c.args[1] === "exec"),
			false,
		);
		assert.match(
			unsafe.notifications[0]?.message ?? "",
			/unexpected report format/,
		);
	});

	it("coalesces concurrent status refreshes into a single follow-up query", async () => {
		let release!: (res: ExecResult) => void;
		let count = 0;
		const h = createHarness(() => {
			count += 1;
			if (count === 1) {
				return new Promise<ExecResult>((r) => {
					release = r;
				});
			}
			return Promise.resolve(makeExec(gainJson(2, 200, 100, 100)));
		});

		await h.emit("session_start");
		await h.emit("agent_settled");
		await h.emit("agent_settled");
		assert.equal(count, 1);

		release(makeExec(gainJson(1, 100, 50, 50)));
		for (let i = 0; i < 8; i++) await Promise.resolve();
		assert.equal(count, 2);
		assert.equal(h.statuses.at(-1), "RTK: 100 tokens saved (50.0%)");
	});
});
