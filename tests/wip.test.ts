import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import wipExtension from "../wip.ts";

const execFileAsync = promisify(execFile);

type NotifyLevel = NonNullable<Parameters<ExtensionUIContext["notify"]>[1]>;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type ExecImpl = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

function okResult(stdout = "", stderr = ""): ExecResult {
	return { stdout, stderr, code: 0, killed: false, truncated: false };
}

function setupWip(execImpl: ExecImpl) {
	const calls: Array<{ args: string[]; options: ExecOptions | undefined }> = [];
	const listeners = new Map<string, Array<() => void>>();
	let handler: CommandOptions["handler"] | undefined;

	wipExtension({
		on(event: string, listener: () => void) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
		},
		registerCommand(_name: string, options: CommandOptions) {
			handler = options.handler;
		},
		async exec(command: string, args: string[], options?: ExecOptions) {
			calls.push({ args: [...args], options });
			return await execImpl(command, args, options);
		},
	} as unknown as ExtensionAPI);

	assert.ok(handler);
	return {
		handler,
		calls,
		emit(event: string) {
			for (const fn of listeners.get(event) ?? []) fn();
		},
	};
}

function createContext(options?: { cwd?: string; isIdle?: boolean }) {
	const notifications: Array<{
		message: string;
		level: NotifyLevel | undefined;
	}> = [];
	const ctx = {
		cwd: options?.cwd ?? "/tmp/repo",
		hasUI: true,
		ui: {
			notify(message: string, level?: NotifyLevel) {
				notifications.push({ message, level });
			},
		},
		isIdle: () => options?.isIdle ?? true,
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications };
}

describe("wipExtension", () => {
	it("creates a real 'wip' commit in a disposable git repository with modified and untracked files", async () => {
		const repoDir = mkdtempSync(join(tmpdir(), "pi-wip-"));
		try {
			const runGit = async (args: string[]) =>
				(await execFileAsync("git", args, { cwd: repoDir })).stdout;
			await runGit(["init"]);
			await runGit(["config", "user.name", "Pi Test"]);
			await runGit(["config", "user.email", "pi-test@example.com"]);
			await runGit(["config", "commit.gpgsign", "false"]);
			await runGit(["config", "core.hooksPath", "/dev/null"]);

			writeFileSync(join(repoDir, "tracked.txt"), "initial\n");
			await runGit(["add", "tracked.txt"]);
			await runGit(["commit", "-m", "initial"]);

			writeFileSync(join(repoDir, "tracked.txt"), "initial\nupdated\n");
			writeFileSync(join(repoDir, "untracked.txt"), "new\n");

			const harness = setupWip(async (command, args, options) => {
				const { stdout, stderr } = await execFileAsync(command, args, {
					cwd: options?.cwd,
					signal: options?.signal,
				});
				return okResult(stdout, stderr);
			});
			const { ctx, notifications } = createContext({ cwd: repoDir });
			await harness.handler("", ctx);

			assert.deepEqual(notifications, [
				{ message: 'Committed with message "wip".', level: "info" },
			]);
			assert.equal((await runGit(["log", "-1", "--pretty=%s"])).trim(), "wip");
			assert.equal((await runGit(["status", "--porcelain"])).trim(), "");
		} finally {
			rmSync(repoDir, { recursive: true, force: true });
		}
	});

	it("enforces argument, idle, and concurrency guards without invoking git", async () => {
		let unblock!: (res: ExecResult) => void;
		const gate = new Promise<ExecResult>((r) => {
			unblock = r;
		});
		let callCount = 0;
		const harness = setupWip(async () => {
			callCount += 1;
			return callCount === 1 ? await gate : okResult();
		});

		const badArgs = createContext();
		await harness.handler("--amend", badArgs.ctx);
		assert.equal(harness.calls.length, 0);
		assert.equal(badArgs.notifications[0]?.level, "error");

		const busy = createContext({ isIdle: false });
		await harness.handler("", busy.ctx);
		assert.equal(harness.calls.length, 0);
		assert.equal(busy.notifications[0]?.level, "warning");

		const first = createContext();
		const second = createContext();
		const inflight = harness.handler("", first.ctx);
		await harness.handler("", second.ctx);
		assert.equal(second.notifications[0]?.message, "/wip is already running.");
		unblock(okResult());
		await inflight;
		assert.equal(harness.calls.length, 2);
	});

	it("stops on git add failure without leaking secret output and aborts cleanly on session_shutdown", async () => {
		const failAdd = setupWip(async () => ({
			stdout: "token=secret_stdout",
			stderr: "fatal: password=secret_stderr",
			code: 128,
			killed: false,
			truncated: false,
		}));
		const failCtx = createContext();
		await failAdd.handler("", failCtx.ctx);
		assert.equal(failAdd.calls.length, 1);
		assert.equal(
			failCtx.notifications[0]?.message,
			"git add . failed (exit code 128).",
		);

		let capturedSignal: AbortSignal | undefined;
		let unblock!: (res: ExecResult) => void;
		const gate = new Promise<ExecResult>((r) => {
			unblock = r;
		});
		const shutdownHarness = setupWip(async (_cmd, _args, options) => {
			capturedSignal = options?.signal;
			return await gate;
		});
		const shutdownCtx = createContext();
		const run = shutdownHarness.handler("", shutdownCtx.ctx);
		shutdownHarness.emit("session_shutdown");
		assert.equal(capturedSignal?.aborted, true);
		unblock({
			stdout: "",
			stderr: "",
			code: 143,
			killed: true,
			truncated: false,
		});
		await run;
		assert.equal(shutdownHarness.calls.length, 1);
		assert.deepEqual(shutdownCtx.notifications, []);
	});
});
