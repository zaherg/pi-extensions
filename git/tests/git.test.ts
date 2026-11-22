import assert from "node:assert/strict";
import {
	type SpawnSyncReturns,
	execFileSync,
	spawn,
	spawnSync,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type {
	CustomEntry,
	EntryRenderOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import gitExtension, { gitShellCommand } from "../index.ts";
import {
	CAPTURE_BYTES,
	gitResultMessage,
	terminalCaptureArgs,
} from "../terminal.ts";

type CommandHandler = (
	args: string,
	ctx: ExtensionCommandContext,
) => Promise<void>;

type EntryRenderer = (
	entry: CustomEntry<string>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component;

type CustomFactory = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: SpawnSyncReturns<Buffer>) => void,
) => Component;

interface HarnessState {
	commandName: string | undefined;
	commandDescription: string | undefined;
	commandHandler: CommandHandler | undefined;
	rendererName: string | undefined;
	entryRenderer: EntryRenderer | undefined;
	entries: Array<{ customType: string; data: unknown }>;
	appendError: Error | undefined;
	emit: (event: string) => void;
}

function createHarness(): { pi: ExtensionAPI; state: HarnessState } {
	const listeners = new Map<string, Array<() => void>>();
	const state: HarnessState = {
		commandName: undefined,
		commandDescription: undefined,
		commandHandler: undefined,
		rendererName: undefined,
		entryRenderer: undefined,
		entries: [],
		appendError: undefined,
		emit(event: string): void {
			for (const listener of listeners.get(event) ?? []) {
				listener();
			}
		},
	};

	const pi = {
		on(event: string, listener: () => void): void {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
		},
		registerEntryRenderer(name: string, renderer: EntryRenderer): void {
			state.rendererName = name;
			state.entryRenderer = renderer;
		},
		registerCommand(
			name: string,
			options: { description?: string; handler: CommandHandler },
		): void {
			state.commandName = name;
			state.commandDescription = options.description;
			state.commandHandler = options.handler;
		},
		appendEntry(customType: string, data?: unknown): void {
			if (state.appendError) {
				throw state.appendError;
			}
			state.entries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	gitExtension(pi);
	return { pi, state };
}

interface MockContextOptions {
	mode?: ExtensionCommandContext["mode"];
	cwd?: string;
	idle?: boolean;
	custom?: (factory: CustomFactory) => Promise<SpawnSyncReturns<Buffer>>;
}

interface MockContextResult {
	ctx: ExtensionCommandContext;
	notifications: Array<{ message: string; level: string | undefined }>;
	customCalls: number;
	tuiEvents: string[];
}

function createMockTheme(): Theme {
	return {
		fg(color: string, text: string): string {
			return `[${color}:${text}]`;
		},
	} as unknown as Theme;
}

function createMockContext(
	options: MockContextOptions = {},
): MockContextResult {
	const notifications: Array<{ message: string; level: string | undefined }> =
		[];
	const tuiEvents: string[] = [];
	const theme = createMockTheme();
	const keybindings = {} as unknown as KeybindingsManager;
	const tui = {
		stop(): void {
			tuiEvents.push("stop");
		},
		start(): void {
			tuiEvents.push("start");
		},
		requestRender(force?: boolean): void {
			tuiEvents.push(force ? "requestRender:force" : "requestRender");
		},
	} as unknown as TUI;

	const state: MockContextResult = {
		ctx: undefined as unknown as ExtensionCommandContext,
		notifications,
		customCalls: 0,
		tuiEvents,
	};

	const defaultCustom = async (
		factory: CustomFactory,
	): Promise<SpawnSyncReturns<Buffer>> => {
		let resolved: SpawnSyncReturns<Buffer> | undefined;
		let doneCalled = false;
		const component = factory(
			tui,
			theme,
			keybindings,
			(result: SpawnSyncReturns<Buffer>): void => {
				doneCalled = true;
				resolved = result;
			},
		);
		assert.deepEqual(component.render(80), []);
		component.invalidate();
		assert.equal(doneCalled, true);
		assert.ok(resolved !== undefined);
		return resolved;
	};

	const customImpl = options.custom ?? defaultCustom;

	state.ctx = {
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? process.cwd(),
		hasUI: (options.mode ?? "tui") === "tui",
		isIdle: (): boolean => options.idle ?? true,
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
			},
			async custom(factory: CustomFactory): Promise<SpawnSyncReturns<Buffer>> {
				state.customCalls += 1;
				return customImpl(factory);
			},
		},
	} as unknown as ExtensionCommandContext;

	return state;
}

function makeSpawnResult(
	overrides: Partial<SpawnSyncReturns<Buffer>> = {},
): SpawnSyncReturns<Buffer> {
	return {
		pid: 12345,
		output: [null, Buffer.alloc(0), Buffer.alloc(0)],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
		...overrides,
	};
}

function hasPython3(): boolean {
	const probe = spawnSync("python3", ["--version"], { stdio: "ignore" });
	return probe.status === 0;
}

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

function createTempGitRepo(prefix = "pi-git-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	execFileSync("git", ["init"], {
		cwd: dir,
		env: HERMETIC_GIT_ENV,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.name", "Pi Test"], {
		cwd: dir,
		env: HERMETIC_GIT_ENV,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.email", "pi-test@example.com"], {
		cwd: dir,
		env: HERMETIC_GIT_ENV,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "commit.gpgsign", "false"], {
		cwd: dir,
		env: HERMETIC_GIT_ENV,
		stdio: "ignore",
	});
	return dir;
}

function withPlatform<T>(
	platform: NodeJS.Platform,
	fn: () => Promise<T>,
): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
	return fn().finally(() => {
		if (original) {
			Object.defineProperty(process, "platform", original);
		}
	});
}

// ---------------------------------------------------------------------------
// gitShellCommand
// ---------------------------------------------------------------------------

test("gitShellCommand: handles empty and whitespace-only inputs", () => {
	assert.equal(gitShellCommand(""), "git");
	assert.equal(gitShellCommand("   "), "git");
	assert.equal(gitShellCommand("\t \r\n "), "git");
});

test("gitShellCommand: passes standard git commands and options through", () => {
	assert.equal(gitShellCommand("status"), "git status");
	assert.equal(gitShellCommand("diff --cached"), "git diff --cached");
	assert.equal(gitShellCommand("log --oneline -10"), "git log --oneline -10");
	assert.equal(
		gitShellCommand("-C ../another-project status"),
		"git -C ../another-project status",
	);
	assert.equal(gitShellCommand("status | head -n 5"), "git status | head -n 5");
});

test("gitShellCommand: rewrites standalone double-quoted commit messages", () => {
	assert.equal(
		gitShellCommand('commit "Fix validation"'),
		'git commit -m "Fix validation"',
	);
	assert.equal(
		gitShellCommand('  \t commit \t "Fix validation" \t\r\n'),
		'git commit -m "Fix validation"',
	);
	assert.equal(
		gitShellCommand('commit "Fix \\"quoted\\" and \\\\ slash"'),
		'git commit -m "Fix \\"quoted\\" and \\\\ slash"',
	);
	assert.equal(
		gitShellCommand('commit "line 1\nline 2"'),
		'git commit -m "line 1\nline 2"',
	);
	assert.equal(gitShellCommand('commit ""'), 'git commit -m ""');
});

test("gitShellCommand: rewrites standalone single-quoted commit messages", () => {
	assert.equal(
		gitShellCommand("commit 'Fix validation'"),
		"git commit -m 'Fix validation'",
	);
	assert.equal(
		gitShellCommand("\tcommit   'line 1\nline 2'  \r\n"),
		"git commit -m 'line 1\nline 2'",
	);
	assert.equal(gitShellCommand("commit ''"), "git commit -m ''");
});

test("gitShellCommand: does not rewrite non-standalone, flagged, or malformed commit invocations", () => {
	const passthroughCases = [
		'commit -m "Fix validation"',
		'commit "Fix validation" --amend',
		'commit "first" "second"',
		'commit "a""b"',
		"commit -- path.txt",
		"commit 'msg' && git push",
		'commit "unterminated',
		"commit 'unterminated",
		'commit "trailing\\',
		"commit unquoted",
		'\ncommit "leading newline"',
		'commit\n"newline between"',
	];
	for (const input of passthroughCases) {
		assert.equal(gitShellCommand(input), `git ${input}`);
	}
});

// ---------------------------------------------------------------------------
// terminalCaptureArgs
// ---------------------------------------------------------------------------

test("terminalCaptureArgs: darwin invocation uses macOS script and keeps shell/command positional", () => {
	const shell = '/bin/zsh "$(echo unsafe)"';
	const command = 'git commit -m "hello $(id) `uname`"';
	const args = terminalCaptureArgs(shell, command, "darwin");

	assert.equal(CAPTURE_BYTES, 16 * 1024);
	assert.equal(args.length, 6);
	assert.equal(args[0], "-c");
	assert.equal(args[2], "pi-git");
	assert.equal(args[3], shell);
	assert.equal(args[4], command);
	assert.equal(args[5], String(CAPTURE_BYTES + 1));

	const script = args[1] ?? "";
	assert.match(script, /set -o pipefail/);
	assert.match(
		script,
		/for tool in \/usr\/bin\/script \/usr\/bin\/tee \/usr\/bin\/tail;/,
	);
	assert.match(script, /exit 127/);
	assert.match(
		script,
		/\/usr\/bin\/script -q \/dev\/null \/bin\/bash -c 'trap : INT; "\$1" -c "\$2"; exit \$\?' pi-git "\$1" "\$2"/,
	);
	assert.match(
		script,
		/2>&1 \| \{ \/usr\/bin\/tee \/dev\/tty 2>\/dev\/null \|\| true; \} \| \/usr\/bin\/tail -c "\$3"/,
	);
	assert.equal(script.includes(shell), false);
	assert.equal(script.includes(command), false);
});

test("terminalCaptureArgs: linux invocation uses GNU script -e -c and keeps shell/command positional", () => {
	const shell = "/bin/bash";
	const command = "git status";
	const args = terminalCaptureArgs(shell, command, "linux");

	assert.equal(args.length, 6);
	assert.equal(args[0], "-c");
	assert.equal(args[2], "pi-git");
	assert.equal(args[3], shell);
	assert.equal(args[4], command);
	assert.equal(args[5], String(CAPTURE_BYTES + 1));

	const script = args[1] ?? "";
	assert.match(script, /set -o pipefail/);
	assert.match(
		script,
		/SHELL="\$1" \/usr\/bin\/script -q -e -c "\$2" \/dev\/null/,
	);
	assert.match(
		script,
		/2>&1 \| \{ \/usr\/bin\/tee \/dev\/tty 2>\/dev\/null \|\| true; \} \| \/usr\/bin\/tail -c "\$3"/,
	);
	assert.equal(script.includes(command), false);
});

test("terminalCaptureArgs: rejects unsupported platforms", () => {
	for (const platform of ["win32", "freebsd", "sunos", "aix"] as const) {
		assert.throws(
			() => terminalCaptureArgs("/bin/sh", "git status", platform),
			{
				name: "Error",
				message: "Git terminal capture requires macOS or Linux.",
			},
		);
	}
});

// ---------------------------------------------------------------------------
// gitResultMessage
// ---------------------------------------------------------------------------

test("gitResultMessage: formats exit 0, non-zero exit, missing tool exit 127, unknown exit, and signals", () => {
	assert.equal(
		gitResultMessage(Buffer.from("On branch main\nnothing to commit\n"), 0),
		"Git shell completed.\nOn branch main\nnothing to commit",
	);
	assert.equal(
		gitResultMessage(Buffer.alloc(0), 0),
		"Git shell completed.\n(No output)",
	);
	assert.equal(gitResultMessage(null, 0), "Git shell completed.\n(No output)");
	assert.equal(
		gitResultMessage(undefined, 0),
		"Git shell completed.\n(No output)",
	);
	assert.equal(
		gitResultMessage(Buffer.from("   \r\n\n  "), 0),
		"Git shell completed.\n(No output)",
	);

	assert.equal(
		gitResultMessage(
			Buffer.from(
				"fatal: not a git repository (or any of the parent directories): .git\n",
			),
			128,
		),
		"Git command failed (exit 128).\nfatal: not a git repository (or any of the parent directories): .git",
	);
	assert.equal(
		gitResultMessage(
			Buffer.from("Git terminal capture requires /usr/bin/script.\n"),
			127,
		),
		"Git command failed (exit 127).\nGit terminal capture requires /usr/bin/script.",
	);
	assert.equal(
		gitResultMessage(Buffer.alloc(0), 1),
		"Git command failed (exit 1).\nNo diagnostic text was captured; check the terminal output.",
	);
	assert.equal(
		gitResultMessage(null, null),
		"Git command failed (exit unknown).\nNo diagnostic text was captured; check the terminal output.",
	);

	assert.equal(
		gitResultMessage(Buffer.from("partial diff\n"), null, "SIGINT"),
		"Git shell stopped by SIGINT. Check git status before retrying.\npartial diff",
	);
	assert.equal(
		gitResultMessage(Buffer.alloc(0), null, "SIGTERM"),
		"Git shell stopped by SIGTERM. Check git status before retrying.\nNo diagnostic text was captured; check the terminal output.",
	);
	assert.equal(
		gitResultMessage(Buffer.alloc(0), 0, "SIGINT"),
		"Git shell stopped by SIGINT. Check git status before retrying.\nNo diagnostic text was captured; check the terminal output.",
	);
});

test("gitResultMessage: handles bounded capture truncation at >CAPTURE_BYTES, exact CAPTURE_BYTES, >20 lines, and >4000 chars", () => {
	// Partial first line must be dropped when output exceeds CAPTURE_BYTES.
	const filler = "a".repeat(CAPTURE_BYTES - 10);
	const overLimit = Buffer.from(`${filler}\nfinal line\n`, "utf8");
	assert.ok(overLimit.length > CAPTURE_BYTES);
	const truncatedOverLimit = gitResultMessage(overLimit, 0);
	assert.equal(
		truncatedOverLimit,
		"Git shell completed.\n[Last output only]\nfinal line",
	);

	// Exact CAPTURE_BYTES output was not stream-cut by tail -c (CAPTURE_BYTES + 1), so line 1 is not dropped as partial.
	const exactFirstLine = "b".repeat(CAPTURE_BYTES - 12);
	const exactLimit = Buffer.from(`${exactFirstLine}\nfinal line\n`, "utf8");
	assert.equal(exactLimit.length, CAPTURE_BYTES);
	const formattedExact = gitResultMessage(exactLimit, 0);
	assert.match(
		formattedExact,
		/^Git shell completed\.\n\[Last output only\]\nb+\nfinal line$/,
	);

	const noNewlineOverLimit = Buffer.alloc(CAPTURE_BYTES + 1, 0x78); // 'x'
	assert.equal(
		gitResultMessage(noNewlineOverLimit, 0),
		"Git shell completed.\n[Last output only]\n(No output)",
	);
	assert.equal(
		gitResultMessage(noNewlineOverLimit, 1),
		"Git command failed (exit 1).\n[Last output only]\nNo diagnostic text was captured; check the terminal output.",
	);

	const manyLines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join(
		"\n",
	);
	const truncatedLines = gitResultMessage(Buffer.from(manyLines), 0);
	assert.match(
		truncatedLines,
		/^Git shell completed\.\n\[Last output only\]\n/,
	);
	assert.equal(truncatedLines.includes("line-5"), false);
	assert.equal(truncatedLines.includes("line-6"), true);
	assert.equal(truncatedLines.includes("line-25"), true);

	const longSingleLine = `PREFIX_${"z".repeat(4500)}_SUFFIX`;
	const truncatedChars = gitResultMessage(Buffer.from(longSingleLine), 0);
	assert.match(
		truncatedChars,
		/^Git shell completed\.\n\[Last output only\]\n/,
	);
	assert.equal(truncatedChars.includes("PREFIX_"), false);
	assert.equal(truncatedChars.endsWith("_SUFFIX"), true);
});

test("gitResultMessage: redacts credentials and strips ANSI, CR, and unsafe control characters", () => {
	const raw = [
		"\u001b[32mremote:\u001b[0m Pushing to https://alice:supersecret@github.com/org/repo.git\r",
		"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig\r\n",
		"token=ghp_1234567890abcdefghij1234567890\n",
		"api_key: sk-1234567890abcdef1234567890\n",
		"https://example.com/hook?X-Amz-Signature=deadbeef1234&ok=1\n",
		"-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET_KEY_BODY\n-----END OPENSSH PRIVATE KEY-----\n",
		"col1\tcol2\u0000\u0007\u202ehidden\n",
	].join("");

	const formatted = gitResultMessage(Buffer.from(raw, "utf8"), 1);
	assert.equal(formatted.includes("\u001b["), false);
	assert.equal(formatted.includes("\r"), false);
	assert.equal(formatted.includes("\u0000"), false);
	assert.equal(formatted.includes("\u0007"), false);
	assert.equal(formatted.includes("\u202e"), false);
	assert.equal(formatted.includes("supersecret"), false);
	assert.equal(formatted.includes("eyJhbGciOiJIUzI1NiJ9"), false);
	assert.equal(formatted.includes("ghp_1234567890abcdefghij1234567890"), false);
	assert.equal(formatted.includes("sk-1234567890abcdef1234567890"), false);
	assert.equal(formatted.includes("deadbeef1234"), false);
	assert.equal(formatted.includes("SECRET_KEY_BODY"), false);

	assert.match(
		formatted,
		/https:\/\/\[REDACTED\]@github\.com\/org\.git|https:\/\/\[REDACTED\]@github\.com\/org\/repo\.git/,
	);
	assert.match(formatted, /Bearer \[REDACTED\]/);
	assert.match(formatted, /\[REDACTED PRIVATE KEY\]/);
	assert.match(formatted, /col1\tcol2hidden/);
});

test("gitResultMessage: preserves UTF-16 surrogate pair safety across 4000-char tail slicing", () => {
	// Test both odd and even offsets so slice(-4000) lands directly on a low surrogate in one case.
	const oddOffset = `A${"🚀".repeat(2500)}B`;
	const evenOffset = `AA${"🚀".repeat(2500)}B`;

	for (const input of [oddOffset, evenOffset]) {
		const formatted = gitResultMessage(Buffer.from(input, "utf8"), 0);
		assert.equal(formatted.isWellFormed(), true);
		assert.match(formatted, /\[Last output only\]/);
		assert.equal(formatted.endsWith("B"), true);
	}
});

// ---------------------------------------------------------------------------
// gitExtension registration & renderer
// ---------------------------------------------------------------------------

test("gitExtension: registers /git command and git-output entry renderer", () => {
	const { state } = createHarness();
	assert.equal(state.commandName, "git");
	assert.equal(typeof state.commandDescription, "string");
	assert.ok((state.commandDescription ?? "").length > 0);
	assert.equal(typeof state.commandHandler, "function");
	assert.equal(state.rendererName, "git-output");
	assert.equal(typeof state.entryRenderer, "function");

	const renderer = state.entryRenderer;
	assert.ok(renderer !== undefined);
	const theme = createMockTheme();
	const options = { expanded: false } as unknown as EntryRenderOptions;

	const validEntry = {
		type: "custom",
		id: "e1",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "git-output",
		data: "Git shell completed.\nOn branch main",
	} as unknown as CustomEntry<string>;

	const renderedCompact = renderer(validEntry, options, theme)
		.render(80)
		.join("\n");
	assert.match(renderedCompact, /\[accent:\/git\]/);
	assert.match(renderedCompact, /Git shell completed\./);
	assert.match(renderedCompact, /On branch main/);

	const renderedExpanded = renderer(
		validEntry,
		{ expanded: true } as unknown as EntryRenderOptions,
		theme,
	)
		.render(80)
		.join("\n");
	assert.match(renderedExpanded, /\[accent:\/git\]/);
	assert.match(renderedExpanded, /On branch main/);

	const invalidEntry = {
		...validEntry,
		data: { unexpected: true } as unknown as string,
	} as unknown as CustomEntry<string>;
	const renderedInvalid = renderer(invalidEntry, options, theme)
		.render(80)
		.join("\n");
	assert.match(renderedInvalid, /Invalid saved Git output\./);
});

// ---------------------------------------------------------------------------
// gitExtension guards, concurrency, SIGINT, and error handling
// ---------------------------------------------------------------------------

test("gitExtension: rejects non-TUI modes without calling UI or appending entries", () => {
	return (async () => {
		const { state } = createHarness();
		const handler = state.commandHandler;
		assert.ok(handler !== undefined);

		const beforeSigint = process.listenerCount("SIGINT");
		for (const mode of ["rpc", "print", "json"] as const) {
			const mock = createMockContext({ mode });
			await assert.rejects(() => handler("status", mock.ctx), {
				name: "Error",
				message: "/git requires Pi's interactive terminal.",
			});
			assert.equal(mock.customCalls, 0);
			assert.equal(mock.notifications.length, 0);
			assert.equal(state.entries.length, 0);
		}
		assert.equal(process.listenerCount("SIGINT"), beforeSigint);
	})();
});

test("gitExtension: warns and exits early when agent is not idle", async () => {
	const { state } = createHarness();
	const handler = state.commandHandler;
	assert.ok(handler !== undefined);

	const mock = createMockContext({ idle: false });
	await handler("status", mock.ctx);

	assert.equal(mock.customCalls, 0);
	assert.equal(state.entries.length, 0);
	assert.deepEqual(mock.notifications, [
		{
			message: "Wait for the current operation to finish before running /git.",
			level: "warning",
		},
	]);
});

test("gitExtension: unsupported platform fails before setting running, registering SIGINT, calling custom, or appending entry", async () => {
	const { state } = createHarness();
	const handler = state.commandHandler;
	assert.ok(handler !== undefined);

	const sigintBefore = process.listenerCount("SIGINT");
	const mock = createMockContext();

	await withPlatform("win32", async () => {
		await assert.rejects(() => handler("status", mock.ctx), {
			name: "Error",
			message: "Git terminal capture requires macOS or Linux.",
		});
	});

	assert.equal(mock.customCalls, 0);
	assert.equal(state.entries.length, 0);
	assert.equal(mock.notifications.length, 0);
	assert.equal(process.listenerCount("SIGINT"), sigintBefore);

	// Verify running was NOT left stuck true: a subsequent call succeeds cleanly.
	const followUp = createMockContext({
		custom: async () =>
			makeSpawnResult({ stdout: Buffer.from("clean\n"), status: 0 }),
	});
	await handler("status", followUp.ctx);
	assert.equal(followUp.customCalls, 1);
	assert.equal(state.entries.length, 1);
	assert.equal(state.entries[0]?.data, "Git shell completed.\nclean");
});

test("gitExtension: rejects concurrent /git invocations and cleans up SIGINT listener", async () => {
	const { state } = createHarness();
	const handler = state.commandHandler;
	assert.ok(handler !== undefined);

	const sigintBefore = process.listenerCount("SIGINT");
	let releaseFirst: (() => void) | undefined;
	let sigintWhileRunning = -1;

	const firstMock = createMockContext({
		custom: () =>
			new Promise<SpawnSyncReturns<Buffer>>((resolve) => {
				sigintWhileRunning = process.listenerCount("SIGINT");
				releaseFirst = (): void => {
					resolve(
						makeSpawnResult({
							stdout: Buffer.from("done\n"),
							status: 0,
						}),
					);
				};
			}),
	});
	const secondMock = createMockContext();

	const firstRun = handler("status", firstMock.ctx);
	// Wait a microtask so firstRun enters ctx.ui.custom.
	await Promise.resolve();

	assert.equal(sigintWhileRunning, sigintBefore + 1);

	await handler("diff", secondMock.ctx);
	assert.equal(secondMock.customCalls, 0);
	assert.deepEqual(secondMock.notifications, [
		{
			message: "Wait for the current operation to finish before running /git.",
			level: "warning",
		},
	]);

	assert.ok(releaseFirst !== undefined);
	releaseFirst();
	await firstRun;

	assert.equal(process.listenerCount("SIGINT"), sigintBefore);
	assert.equal(state.entries.length, 1);
	assert.deepEqual(state.entries[0], {
		customType: "git-output",
		data: "Git shell completed.\ndone",
	});

	// Running flag is reset so a third invocation works.
	const thirdMock = createMockContext({
		custom: async () =>
			makeSpawnResult({ stdout: Buffer.from("third\n"), status: 0 }),
	});
	await handler("status", thirdMock.ctx);
	assert.equal(thirdMock.customCalls, 1);
	assert.equal(state.entries.length, 2);
});

test("gitExtension: handles result.error, custom throw without leaking secrets, appendEntry failure, stale ctx, and session replacement", async () => {
	const { state } = createHarness();
	const handler = state.commandHandler;
	assert.ok(handler !== undefined);

	const sigintBefore = process.listenerCount("SIGINT");

	// 1. spawnSync returned an error object
	const errorResultMock = createMockContext({
		custom: async () =>
			makeSpawnResult({
				status: null,
				error: new Error("spawn /bin/bash ENOENT"),
			}),
	});
	await handler("status", errorResultMock.ctx);
	assert.deepEqual(state.entries[0], {
		customType: "git-output",
		data: "Git shell could not be started. Check SHELL and the project directory.",
	});

	// 2. ctx.ui.custom throws an error containing sensitive text
	const throwMock = createMockContext({
		custom: async () => {
			throw new Error("ghp_1234567890abcdefghij1234567890 crashed");
		},
	});
	await handler("status", throwMock.ctx);
	assert.deepEqual(state.entries[1], {
		customType: "git-output",
		data: "Git terminal execution failed. Check git status before retrying.",
	});
	assert.equal(process.listenerCount("SIGINT"), sigintBefore);

	// 3. pi.appendEntry throws -> warns instead of rejecting
	state.appendError = new Error("session write failed");
	const appendFailMock = createMockContext({
		custom: async () =>
			makeSpawnResult({ stdout: Buffer.from("ok\n"), status: 0 }),
	});
	await handler("status", appendFailMock.ctx);
	assert.deepEqual(appendFailMock.notifications, [
		{
			message: "Could not save Git's inline result.\nGit shell completed.\nok",
			level: "warning",
		},
	]);

	// 4. Stale ctx after session.dispose() (both appendEntry and ctx.hasUI throw) must not reject
	let stale = false;
	const baseStale = createMockContext({
		custom: async () => {
			stale = true;
			return makeSpawnResult({ stdout: Buffer.from("ok\n"), status: 0 });
		},
	});
	const staleProxy = new Proxy(baseStale.ctx, {
		get(target, prop, receiver) {
			if (stale) {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	await assert.doesNotReject(handler("status", staleProxy));

	// 5. Session replacement mid-custom suppresses writing to the new session
	state.appendError = undefined;
	const entriesBefore = state.entries.length;
	const switchedMock = createMockContext({
		custom: async () => {
			state.emit("session_start");
			return makeSpawnResult({
				stdout: Buffer.from("wrong-session\n"),
				status: 0,
			});
		},
	});
	await handler("status", switchedMock.ctx);
	assert.equal(state.entries.length, entriesBefore);
});

test("gitExtension: non-existent cwd restores TUI and records spawn error cleanly", async () => {
	const { state } = createHarness();
	const handler = state.commandHandler;
	assert.ok(handler !== undefined);

	const missingDir = join(
		tmpdir(),
		`pi-git-nonexistent-${Date.now()}-${Math.random()}`,
	);
	const mock = createMockContext({ cwd: missingDir });
	await handler("status", mock.ctx);

	assert.deepEqual(mock.tuiEvents, ["stop", "start", "requestRender:force"]);
	assert.deepEqual(state.entries[0], {
		customType: "git-output",
		data: "Git shell could not be started. Check SHELL and the project directory.",
	});
});

test("terminalCaptureArgs: succeeds with exit 0 when /dev/tty has no controlling terminal", {
	skip: process.platform !== "darwin" && process.platform !== "linux",
}, async () => {
	const repo = createTempGitRepo("pi-git-headless-");
	try {
		const captureArgs = terminalCaptureArgs("/bin/sh", "git status --short");
		const status = await new Promise<number | null>(
			(resolveExit, rejectExit) => {
				const child = spawn("/bin/bash", captureArgs, {
					cwd: repo,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				child.stdout.resume();
				child.stderr.resume();
				child.on("error", rejectExit);
				child.on("close", (code) => resolveExit(code));
			},
		);
		assert.equal(status, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Real disposable git repository execution under a real PTY
// ---------------------------------------------------------------------------

interface PtyE2EResult {
	tuiEvents: string[][];
	entries: Array<{ customType: string; data: string }>;
}

test("gitExtension: executes real git commands end-to-end in a disposable repository under a real PTY", {
	skip:
		(process.platform !== "darwin" && process.platform !== "linux") ||
		!hasPython3(),
}, () => {
	const repo = createTempGitRepo("pi-git-repo-$safe ");
	const workDir = mkdtempSync(join(tmpdir(), "pi-git-pty-runner-"));
	const resultFile = join(workDir, "result.json");
	const runnerFile = join(workDir, "runner.mjs");
	const gitExtUrl = pathToFileURL(resolve("git/index.ts")).href;
	const loaderPath = resolve("shared/tests/pi-loader.ts");

	try {
		// Configure a local git alias that prints > 16 KiB to exercise bounded tail capture.
		execFileSync(
			"git",
			[
				"config",
				"alias.flood",
				'!node -e \'for (let i = 1; i <= 600; i++) console.log("flood-line-" + i + "-" + "x".repeat(40))\'',
			],
			{ cwd: repo, env: HERMETIC_GIT_ENV, stdio: "ignore" },
		);

		writeFileSync(
			runnerFile,
			`import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import gitExtension from ${JSON.stringify(gitExtUrl)};

const repo = ${JSON.stringify(repo)};
const resultFile = ${JSON.stringify(resultFile)};

let handler;
const entries = [];
const pi = {
	on() {},
	registerEntryRenderer() {},
	registerCommand(_name, opts) { handler = opts.handler; },
	appendEntry(customType, data) { entries.push({ customType, data }); },
};
gitExtension(pi);

const tuiEvents = [];
function makeCtx() {
	const events = [];
	tuiEvents.push(events);
	const tui = {
		stop() { events.push("stop"); },
		start() { events.push("start"); },
		requestRender(force) { events.push(force ? "requestRender:force" : "requestRender"); },
	};
	return {
		mode: "tui",
		cwd: repo,
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify() {},
			async custom(factory) {
				let resolved;
				factory(tui, {}, {}, (r) => { resolved = r; });
				return resolved;
			},
		},
	};
}

// 1. status with SHELL unset (falls back to /bin/sh)
delete process.env.SHELL;
await handler("status --short --branch", makeCtx());

// 2. commit with standalone double-quoted shortcut
writeFileSync(join(repo, "hello.txt"), "hello world\\n", "utf8");
execFileSync("git", ["add", "hello.txt"], { cwd: repo, stdio: "ignore" });
await handler('commit "Initial commit from /git"', makeCtx());

// 3. commit with standalone single-quoted shortcut
writeFileSync(join(repo, "hello.txt"), "updated\\n", "utf8");
execFileSync("git", ["add", "hello.txt"], { cwd: repo, stdio: "ignore" });
await handler("commit 'Second commit'", makeCtx());

// 4. non-zero exit command
await handler("rev-parse --verify refs/heads/no-such-branch", makeCtx());

// 5. empty args invokes bare git usage (exit 1)
await handler("   ", makeCtx());

// 6. >16 KiB output triggers bounded tail capture with [Last output only]
await handler("flood", makeCtx());

writeFileSync(resultFile, JSON.stringify({ tuiEvents, entries }), "utf8");
`,
			"utf8",
		);

		const pyScript = `import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
else:
    while True:
        try:
            if not os.read(fd, 4096):
                break
        except OSError:
            break
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
`;

		const run = spawnSync(
			"python3",
			["-c", pyScript, process.execPath, "--import", loaderPath, runnerFile],
			{
				cwd: process.cwd(),
				env: HERMETIC_GIT_ENV,
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		assert.equal(
			run.status,
			0,
			`PTY runner failed (status=${String(run.status)}): ${run.stdout}\n${run.stderr}`,
		);

		const parsed = JSON.parse(readFileSync(resultFile, "utf8")) as PtyE2EResult;

		assert.equal(parsed.entries.length, 6);
		for (const events of parsed.tuiEvents) {
			assert.deepEqual(events, ["stop", "start", "requestRender:force"]);
		}

		// 1. status
		assert.equal(parsed.entries[0]?.customType, "git-output");
		assert.match(parsed.entries[0]?.data ?? "", /^Git shell completed\./);

		// 2. double-quoted commit
		assert.match(parsed.entries[1]?.data ?? "", /^Git shell completed\./);

		// 3. single-quoted commit
		assert.match(parsed.entries[2]?.data ?? "", /^Git shell completed\./);
		const subjects = execFileSync("git", ["log", "--format=%s"], {
			cwd: repo,
			env: HERMETIC_GIT_ENV,
			encoding: "utf8",
		})
			.trim()
			.split("\n");
		assert.deepEqual(subjects, ["Second commit", "Initial commit from /git"]);

		// 4. non-zero exit
		assert.match(
			parsed.entries[3]?.data ?? "",
			/^Git command failed \(exit 128\)\./,
		);
		assert.match(parsed.entries[3]?.data ?? "", /Needed a single revision/);

		// 5. empty args usage (>20 lines, so tail shows [Last output only] + git help footer)
		assert.match(
			parsed.entries[4]?.data ?? "",
			/^Git command failed \(exit 1\)\.\n\[Last output only\]\n/,
		);
		assert.match(parsed.entries[4]?.data ?? "", /git help/i);

		// 6. bounded >16 KiB capture
		assert.match(
			parsed.entries[5]?.data ?? "",
			/^Git shell completed\.\n\[Last output only\]\n/,
		);
		assert.equal(
			(parsed.entries[5]?.data ?? "").includes("flood-line-1-"),
			false,
		);
		assert.equal(
			(parsed.entries[5]?.data ?? "").includes("flood-line-600-"),
			true,
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});
