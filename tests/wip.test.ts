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

interface ExecCall {
	command: string;
	args: string[];
	options: ExecOptions | undefined;
}

interface Notification {
	message: string;
	level: NotifyLevel | undefined;
}

type ExecImpl = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

function okResult(stdout = "", stderr = ""): ExecResult {
	return { stdout, stderr, code: 0, killed: false, truncated: false };
}

function setupWipExtension(execImpl: ExecImpl): {
	handler: CommandOptions["handler"];
	commandName: string;
	description: string | undefined;
	calls: ExecCall[];
	emit: (event: string) => void;
	registeredEvents: string[];
} {
	const calls: ExecCall[] = [];
	const listeners = new Map<string, Array<() => void>>();
	let registeredName = "";
	let registeredOptions: CommandOptions | undefined;

	const pi = {
		on(event: string, listener: () => void): void {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
		},
		registerCommand(name: string, options: CommandOptions): void {
			registeredName = name;
			registeredOptions = options;
		},
		async exec(
			command: string,
			args: string[],
			options?: ExecOptions,
		): Promise<ExecResult> {
			calls.push({ command, args: [...args], options });
			return await execImpl(command, args, options);
		},
	} as unknown as ExtensionAPI;

	wipExtension(pi);

	assert.ok(registeredOptions, "expected /wip command to be registered");
	return {
		handler: registeredOptions.handler,
		commandName: registeredName,
		description: registeredOptions.description,
		calls,
		registeredEvents: [...listeners.keys()],
		emit(event: string): void {
			for (const listener of listeners.get(event) ?? []) {
				listener();
			}
		},
	};
}

function createCommandContext(options?: {
	cwd?: string;
	isIdle?: boolean;
	hasUI?: boolean;
}): {
	ctx: ExtensionCommandContext;
	notifications: Notification[];
} {
	const notifications: Notification[] = [];
	const hasUI = options?.hasUI ?? true;
	const idle = options?.isIdle ?? true;
	const cwd = options?.cwd ?? "/tmp/repo";

	const ui = hasUI
		? {
				notify(message: string, level?: NotifyLevel): void {
					notifications.push({ message, level });
				},
			}
		: {
				notify(): never {
					throw new Error(
						"ctx.ui.notify must not be called when hasUI is false",
					);
				},
			};

	const ctx = {
		cwd,
		hasUI,
		ui,
		isIdle(): boolean {
			return idle;
		},
	} as unknown as ExtensionCommandContext;

	return { ctx, notifications };
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("wipExtension", () => {
	it("registers /wip command and session lifecycle hooks", () => {
		const harness = setupWipExtension(async () => okResult());
		assert.equal(harness.commandName, "wip");
		assert.equal(harness.description, 'Run git add . && git commit -m "wip"');
		assert.deepEqual(harness.registeredEvents.sort(), [
			"session_shutdown",
			"session_start",
		]);
	});

	describe("happy paths", () => {
		it("runs git add . then git commit -m wip with expected exec options and notifies success", async () => {
			const harness = setupWipExtension(async () => okResult());
			const { ctx, notifications } = createCommandContext({
				cwd: "/workspace/project",
			});

			await harness.handler("", ctx);

			assert.equal(harness.calls.length, 2);

			const addCall = harness.calls[0];
			const commitCall = harness.calls[1];
			assert.ok(addCall);
			assert.ok(commitCall);

			assert.deepEqual(addCall.args, ["add", "."]);
			assert.deepEqual(commitCall.args, ["commit", "-m", "wip"]);

			for (const call of [addCall, commitCall]) {
				assert.equal(call.options?.cwd, "/workspace/project");
				assert.equal(call.options?.timeout, 30_000);
				assert.equal(call.options?.maxBuffer, 1024 * 1024);
				assert.ok(call.options?.signal instanceof AbortSignal);
				assert.equal(call.options.signal.aborted, false);
			}
			assert.equal(addCall.options?.signal, commitCall.options?.signal);

			assert.deepEqual(notifications, [
				{ message: 'Committed with message "wip".', level: "info" },
			]);
		});

		it("treats whitespace-only args as empty and works when hasUI is false", async () => {
			const harness = setupWipExtension(async () => okResult());
			const { ctx } = createCommandContext({ hasUI: false });

			await harness.handler("   \t  ", ctx);

			assert.equal(harness.calls.length, 2);
		});

		it("creates a real 'wip' commit in a disposable temp git repository with modified and untracked files", async () => {
			const repoDir = mkdtempSync(join(tmpdir(), "pi-wip-integration-"));
			try {
				const runGit = async (args: string[]): Promise<string> => {
					const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
					return stdout;
				};

				await runGit(["init"]);
				await runGit(["config", "user.name", "Pi Test"]);
				await runGit(["config", "user.email", "pi-test@example.com"]);
				await runGit(["config", "commit.gpgsign", "false"]);
				await runGit(["config", "core.hooksPath", "/dev/null"]);

				writeFileSync(join(repoDir, "tracked.txt"), "initial\n");
				await runGit(["add", "tracked.txt"]);
				await runGit(["commit", "-m", "initial"]);

				// Modify tracked file and add a new untracked file.
				writeFileSync(join(repoDir, "tracked.txt"), "initial\nupdated\n");
				writeFileSync(join(repoDir, "untracked.txt"), "brand new file\n");

				const realExec: ExecImpl = async (command, args, options) => {
					try {
						const { stdout, stderr } = await execFileAsync(command, args, {
							cwd: options?.cwd,
							signal: options?.signal,
							timeout: options?.timeout,
							maxBuffer: options?.maxBuffer,
						});
						return {
							stdout,
							stderr,
							code: 0,
							killed: false,
							truncated: false,
						};
					} catch (error: unknown) {
						const err = error as {
							stdout?: string;
							stderr?: string;
							code?: number | string;
							killed?: boolean;
						};
						return {
							stdout: err.stdout ?? "",
							stderr: err.stderr ?? "",
							code: typeof err.code === "number" ? err.code : 1,
							killed: Boolean(err.killed),
							truncated: false,
						};
					}
				};

				const harness = setupWipExtension(realExec);
				const { ctx, notifications } = createCommandContext({ cwd: repoDir });

				await harness.handler("", ctx);

				assert.deepEqual(notifications, [
					{ message: 'Committed with message "wip".', level: "info" },
				]);

				const subject = (await runGit(["log", "-1", "--pretty=%s"])).trim();
				assert.equal(subject, "wip");

				const status = (await runGit(["status", "--porcelain"])).trim();
				assert.equal(status, "");

				const committedFiles = (
					await runGit(["show", "--name-only", "--pretty=", "HEAD"])
				)
					.trim()
					.split("\n")
					.sort();
				assert.deepEqual(committedFiles, ["tracked.txt", "untracked.txt"]);
			} finally {
				rmSync(repoDir, { recursive: true, force: true });
			}
		});
	});

	describe("validation and concurrency guards", () => {
		it("rejects extra arguments without executing git", async () => {
			const harness = setupWipExtension(async () => okResult());
			const { ctx, notifications } = createCommandContext();

			await harness.handler("--amend", ctx);

			assert.equal(harness.calls.length, 0);
			assert.deepEqual(notifications, [
				{ message: "Usage: /wip (no arguments)", level: "error" },
			]);
		});

		it("rejects invocation when !ctx.isIdle() without executing git", async () => {
			const harness = setupWipExtension(async () => okResult());
			const { ctx, notifications } = createCommandContext({ isIdle: false });

			await harness.handler("", ctx);

			assert.equal(harness.calls.length, 0);
			assert.deepEqual(notifications, [
				{
					message:
						"Wait for the current operation to finish before running /wip.",
					level: "warning",
				},
			]);
		});

		it("rejects concurrent /wip invocations while one is already running", async () => {
			const gate = createDeferred<ExecResult>();
			let execCount = 0;
			const harness = setupWipExtension(async () => {
				execCount += 1;
				if (execCount === 1) return await gate.promise;
				return okResult();
			});

			const first = createCommandContext();
			const second = createCommandContext();

			const firstRun = harness.handler("", first.ctx);
			await harness.handler("", second.ctx);

			assert.deepEqual(second.notifications, [
				{ message: "/wip is already running.", level: "warning" },
			]);
			assert.equal(harness.calls.length, 1);

			gate.resolve(okResult());
			await firstRun;

			assert.equal(harness.calls.length, 2);
			assert.deepEqual(first.notifications, [
				{ message: 'Committed with message "wip".', level: "info" },
			]);
		});

		it("reports missing git when resolveExecutable returns undefined", async () => {
			const platformDescriptor = Object.getOwnPropertyDescriptor(
				process,
				"platform",
			);
			const originalPath = process.env.PATH;
			try {
				Object.defineProperty(process, "platform", {
					value: "win32",
					configurable: true,
				});
				process.env.PATH = "";

				const harness = setupWipExtension(async () => okResult());
				const { ctx, notifications } = createCommandContext();

				await harness.handler("", ctx);

				assert.equal(harness.calls.length, 0);
				assert.deepEqual(notifications, [
					{ message: "git was not found on PATH.", level: "error" },
				]);
			} finally {
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
				if (originalPath === undefined) {
					delete process.env.PATH;
				} else {
					process.env.PATH = originalPath;
				}
			}
		});
	});

	describe("error handling and output isolation", () => {
		it("stops on git add failure without running git commit or leaking output", async () => {
			const harness = setupWipExtension(async () => ({
				stdout: "secret_token=leaked_stdout",
				stderr: "fatal: not a git repository password=leaked_stderr",
				code: 128,
				killed: false,
				truncated: false,
			}));
			const { ctx, notifications } = createCommandContext();

			await harness.handler("", ctx);

			assert.equal(harness.calls.length, 1);
			assert.deepEqual(notifications, [
				{ message: "git add . failed (exit code 128).", level: "error" },
			]);
			assert.ok(!notifications[0]?.message.includes("leaked_"));
		});

		it("reports git commit failure without leaking hook stdout or stderr", async () => {
			const harness = setupWipExtension(async (_command, args) => {
				if (args[0] === "commit") {
					return {
						stdout: "pre-commit hook API_KEY=sk-1234567890abcdef1234",
						stderr: "hook failed with Bearer supersecret",
						code: 1,
						killed: false,
						truncated: false,
					};
				}
				return okResult();
			});
			const { ctx, notifications } = createCommandContext();

			await harness.handler("", ctx);

			assert.equal(harness.calls.length, 2);
			assert.deepEqual(notifications, [
				{ message: "git commit -m wip failed (exit code 1).", level: "error" },
			]);
			assert.ok(!notifications[0]?.message.includes("sk-"));
			assert.ok(!notifications[0]?.message.includes("Bearer"));
		});

		it("reports timeout or interruption when result.killed is true (even if exit code is 0)", async () => {
			const harness = setupWipExtension(async (_command, args) => {
				if (args[0] === "add") {
					return {
						stdout: "",
						stderr: "",
						code: 0,
						killed: true,
						truncated: false,
					};
				}
				return okResult();
			});
			const { ctx, notifications } = createCommandContext();

			await harness.handler("", ctx);

			assert.equal(harness.calls.length, 1);
			assert.deepEqual(notifications, [
				{
					message:
						"git add . was interrupted or timed out. Check git status before retrying.",
					level: "error",
				},
			]);
		});

		it("reports execution error when pi.exec throws on add or commit", async () => {
			const addFail = setupWipExtension(async () => {
				throw new Error("spawn git ENOENT secret=hidden");
			});
			const firstCtx = createCommandContext();
			await addFail.handler("", firstCtx.ctx);
			assert.deepEqual(firstCtx.notifications, [
				{ message: "git add . could not be executed.", level: "error" },
			]);

			const commitFail = setupWipExtension(async (_command, args) => {
				if (args[0] === "commit") {
					throw new Error("EACCES");
				}
				return okResult();
			});
			const secondCtx = createCommandContext();
			await commitFail.handler("", secondCtx.ctx);
			assert.deepEqual(secondCtx.notifications, [
				{ message: "git commit -m wip could not be executed.", level: "error" },
			]);
		});

		it("resets running state in finally after failure or exception so subsequent /wip runs succeed", async () => {
			let attempt = 0;
			const harness = setupWipExtension(async () => {
				attempt += 1;
				if (attempt === 1) {
					throw new Error("transient failure");
				}
				if (attempt === 2) {
					return {
						stdout: "",
						stderr: "",
						code: 1,
						killed: false,
						truncated: false,
					};
				}
				return okResult();
			});

			const run1 = createCommandContext();
			await harness.handler("", run1.ctx);
			assert.deepEqual(run1.notifications, [
				{ message: "git add . could not be executed.", level: "error" },
			]);

			const run2 = createCommandContext();
			await harness.handler("", run2.ctx);
			assert.deepEqual(run2.notifications, [
				{ message: "git add . failed (exit code 1).", level: "error" },
			]);

			const run3 = createCommandContext();
			await harness.handler("", run3.ctx);
			assert.deepEqual(run3.notifications, [
				{ message: 'Committed with message "wip".', level: "info" },
			]);
		});
	});

	describe("session lifecycle hooks", () => {
		it("session_shutdown aborts an in-flight command, prevents git commit, and suppresses post-shutdown notify", async () => {
			const gate = createDeferred<ExecResult>();
			let capturedSignal: AbortSignal | undefined;
			const harness = setupWipExtension(async (_command, _args, options) => {
				capturedSignal = options?.signal;
				return await gate.promise;
			});

			const { ctx, notifications } = createCommandContext();
			const run = harness.handler("", ctx);

			assert.ok(capturedSignal instanceof AbortSignal);
			assert.equal(capturedSignal.aborted, false);

			harness.emit("session_shutdown");
			assert.equal(capturedSignal.aborted, true);

			gate.resolve({
				stdout: "",
				stderr: "",
				code: 143,
				killed: true,
				truncated: false,
			});
			await run;

			assert.equal(harness.calls.length, 1);
			assert.deepEqual(notifications, []);
		});

		it("session_shutdown suppresses notify even if in-flight pi.exec rejects or resolves with code 0", async () => {
			const rejectGate = createDeferred<ExecResult>();
			const harness1 = setupWipExtension(async () => await rejectGate.promise);
			const ctx1 = createCommandContext();
			const run1 = harness1.handler("", ctx1.ctx);
			harness1.emit("session_shutdown");
			rejectGate.reject(new Error("aborted"));
			await run1;
			assert.deepEqual(ctx1.notifications, []);

			const resolveGate = createDeferred<ExecResult>();
			const harness2 = setupWipExtension(async () => await resolveGate.promise);
			const ctx2 = createCommandContext();
			const run2 = harness2.handler("", ctx2.ctx);
			harness2.emit("session_shutdown");
			resolveGate.resolve(okResult());
			await run2;
			assert.equal(harness2.calls.length, 1);
			assert.deepEqual(ctx2.notifications, []);
		});

		it("session_start aborts any prior controller and re-enables /wip with a fresh signal", async () => {
			const gate = createDeferred<ExecResult>();
			const signals: AbortSignal[] = [];
			let callIndex = 0;

			const harness = setupWipExtension(async (_command, _args, options) => {
				if (options?.signal) signals.push(options.signal);
				callIndex += 1;
				if (callIndex === 1) return await gate.promise;
				return okResult();
			});

			const first = createCommandContext();
			const firstRun = harness.handler("", first.ctx);
			assert.equal(signals[0]?.aborted, false);

			// Starting a new session aborts the in-flight run's controller.
			harness.emit("session_start");
			assert.equal(signals[0]?.aborted, true);

			gate.resolve({
				stdout: "",
				stderr: "",
				code: 143,
				killed: true,
				truncated: false,
			});
			await firstRun;
			assert.deepEqual(first.notifications, []);

			// Subsequent /wip works cleanly with a new non-aborted signal.
			const second = createCommandContext();
			await harness.handler("", second.ctx);
			assert.equal(signals.length, 3);
			assert.notEqual(signals[1], signals[0]);
			assert.equal(signals[1]?.aborted, false);
			assert.deepEqual(second.notifications, [
				{ message: 'Committed with message "wip".', level: "info" },
			]);
		});

		it("session_start re-enables /wip after session_shutdown", async () => {
			const harness = setupWipExtension(async () => okResult());

			harness.emit("session_shutdown");
			const duringShutdown = createCommandContext();
			await harness.handler("", duringShutdown.ctx);
			assert.equal(harness.calls.length, 0);
			assert.deepEqual(duringShutdown.notifications, []);

			harness.emit("session_start");
			const afterRestart = createCommandContext();
			await harness.handler("", afterRestart.ctx);
			assert.equal(harness.calls.length, 2);
			assert.deepEqual(afterRestart.notifications, [
				{ message: 'Committed with message "wip".', level: "info" },
			]);
		});
	});
});
