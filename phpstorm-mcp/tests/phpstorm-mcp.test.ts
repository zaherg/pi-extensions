import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ExtensionContext,
	McpServerConfig,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import phpstormMcp, {
	isMcpDisabled,
	resolvePhpStormCommand,
} from "../index.ts";
import { isPhpStormRunning, windowsPowerShell } from "../running.ts";

type SessionStartHandler = (
	event: SessionStartEvent,
	ctx: ExtensionContext,
) => Promise<void>;

interface ExecCall {
	command: string;
	args: string[];
	options: ExecOptions | undefined;
}

function makeExecResult(
	overrides: Partial<ExecResult> & { stdout?: string } = {},
): ExecResult {
	return {
		stdout: overrides.stdout ?? "",
		stderr: overrides.stderr ?? "",
		code: overrides.code ?? 0,
		killed: overrides.killed ?? false,
		truncated: overrides.truncated ?? false,
	};
}

function createExecPi(
	impl: (
		command: string,
		args: string[],
		options?: ExecOptions,
	) => Promise<ExecResult>,
): { pi: Pick<ExtensionAPI, "exec">; calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	const pi: Pick<ExtensionAPI, "exec"> = {
		exec(
			command: string,
			args: string[],
			options?: ExecOptions,
		): Promise<ExecResult> {
			calls.push({ command, args, options });
			return impl(command, args, options);
		},
	};
	return { pi, calls };
}

function runningResultForCurrentPlatform(running: boolean): ExecResult {
	if (process.platform === "linux") {
		return makeExecResult({
			stdout: running
				? "phpstorm /home/user/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm\n"
				: "node /usr/bin/pi --mode rpc\n",
		});
	}
	if (process.platform === "win32") {
		return makeExecResult({ stdout: running ? "True\r\n" : "False\r\n" });
	}
	return makeExecResult({ stdout: running ? "true\n" : "false\n" });
}

interface ExtensionHarness {
	pi: ExtensionAPI;
	sessionStartHandlers: SessionStartHandler[];
	emitShutdown: () => void;
	execCalls: ExecCall[];
	registered: Array<{ name: string; config: McpServerConfig }>;
}

function createExtensionHarness(
	execImpl: (
		command: string,
		args: string[],
		options?: ExecOptions,
	) => Promise<ExecResult>,
): ExtensionHarness {
	const sessionStartHandlers: SessionStartHandler[] = [];
	const shutdownHandlers: Array<() => void> = [];
	const execCalls: ExecCall[] = [];
	const registered: Array<{ name: string; config: McpServerConfig }> = [];

	const pi = {
		on(event: string, handler: SessionStartHandler | (() => void)): void {
			if (event === "session_start") {
				sessionStartHandlers.push(handler as SessionStartHandler);
			} else if (event === "session_shutdown") {
				shutdownHandlers.push(handler as () => void);
			}
		},
		exec(
			command: string,
			args: string[],
			options?: ExecOptions,
		): Promise<ExecResult> {
			execCalls.push({ command, args, options });
			return execImpl(command, args, options);
		},
		registerMcpServer(name: string, config: McpServerConfig): void {
			registered.push({ name, config });
		},
	} as unknown as ExtensionAPI;

	phpstormMcp(pi);
	return {
		pi,
		sessionStartHandlers,
		emitShutdown(): void {
			for (const fn of shutdownHandlers) fn();
		},
		execCalls,
		registered,
	};
}

function makeSessionStartEvent(): SessionStartEvent {
	return { type: "session_start" } as unknown as SessionStartEvent;
}

function makeExtensionContext(
	mode: ExtensionContext["mode"],
): ExtensionContext {
	return { mode } as unknown as ExtensionContext;
}

async function withTempHome<T>(
	fn: (homeDir: string) => Promise<T>,
): Promise<T> {
	const tempHome = mkdtempSync(join(tmpdir(), "pi-phpstorm-mcp-home-"));
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;
	try {
		return await fn(tempHome);
	} finally {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// windowsPowerShell
// ---------------------------------------------------------------------------

test("windowsPowerShell: resolves System32 PowerShell from SystemRoot, windir, or default", () => {
	assert.equal(
		windowsPowerShell({ SystemRoot: "C:\\Windows" }),
		"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
	assert.equal(
		windowsPowerShell({ SystemRoot: "D:/WinNT" }),
		"D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
	assert.equal(
		windowsPowerShell({ windir: "E:\\Windows" }),
		"E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
	// Rejects relative paths, UNC paths, and drive-relative paths to prevent cwd/network hijack.
	assert.equal(
		windowsPowerShell({
			SystemRoot: "\\\\attacker\\share",
			windir: "F:\\Windows",
		}),
		"F:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
	assert.equal(
		windowsPowerShell({
			SystemRoot: "Windows",
			windir: "C:Windows",
		}),
		"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
	assert.equal(
		windowsPowerShell({
			SystemRoot: "/usr/bin",
			windir: "",
		}),
		"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
	assert.equal(
		windowsPowerShell({}),
		"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
});

// ---------------------------------------------------------------------------
// isPhpStormRunning — macOS (darwin)
// ---------------------------------------------------------------------------

test("isPhpStormRunning (darwin): detects running vs closed GUI PhpStorm (release & EAP) via osascript", async () => {
	const runningExec = createExecPi(async () =>
		makeExecResult({ stdout: "true\n" }),
	);
	assert.equal(await isPhpStormRunning(runningExec.pi, "darwin"), true);
	assert.equal(runningExec.calls.length, 1);
	assert.equal(runningExec.calls[0]?.command, "/usr/bin/osascript");
	assert.equal(runningExec.calls[0]?.args[0], "-l");
	assert.equal(runningExec.calls[0]?.args[1], "JavaScript");
	assert.equal(runningExec.calls[0]?.args[2], "-e");
	const jxaScript = runningExec.calls[0]?.args[3] ?? "";
	assert.match(jxaScript, /com\.jetbrains\.PhpStorm/);
	assert.match(jxaScript, /com\.jetbrains\.PhpStorm-EAP/);
	assert.match(jxaScript, /activationPolicy/);
	assert.match(jxaScript, /!app\.terminated/);
	assert.deepEqual(runningExec.calls[0]?.options, {
		timeout: 2000,
		maxBuffer: 1024 * 1024,
	});

	const closedExec = createExecPi(async () =>
		makeExecResult({ stdout: "  False \r\n" }),
	);
	assert.equal(await isPhpStormRunning(closedExec.pi, "darwin"), false);
});

test("isPhpStormRunning (darwin): rejects empty or unexpected osascript output", async () => {
	for (const stdout of ["", "   \n", "1", "yes", "undefined"]) {
		const { pi } = createExecPi(async () => makeExecResult({ stdout }));
		await assert.rejects(() => isPhpStormRunning(pi, "darwin"), {
			name: "Error",
			message:
				"Failed to check whether PhpStorm is running: unexpected process query output; MCP was not registered.",
		});
	}
});

// ---------------------------------------------------------------------------
// isPhpStormRunning — Linux
// ---------------------------------------------------------------------------

test("isPhpStormRunning (linux): detects native standard/Toolbox and Java PhpStorm processes", async () => {
	const positiveOutputs = [
		// Standard install native binary
		"phpstorm /opt/phpstorm/bin/phpstorm\n",
		// JetBrains Toolbox install
		"phpstorm /home/zaher/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm\n",
		// 64-bit binary name
		"phpstorm64 /usr/local/phpstorm/bin/phpstorm64\n",
		// Java launcher with platform prefix
		"java /opt/phpstorm/jbr/bin/java -Xmx2048m -Didea.platform.prefix=PhpStorm com.intellij.idea.Main\n",
		// Both leftover stdioMcpServer AND real GUI PhpStorm running simultaneously
		[
			"phpstorm /home/zaher/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm stdioMcpServer",
			"phpstorm /home/zaher/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm",
		].join("\n"),
	];

	for (const stdout of positiveOutputs) {
		const { pi, calls } = createExecPi(async () => makeExecResult({ stdout }));
		assert.equal(await isPhpStormRunning(pi, "linux"), true);
		assert.equal(calls[0]?.command, "ps");
		assert.deepEqual(calls[0]?.args, ["-Aww", "-o", "comm=", "-o", "args="]);
		assert.deepEqual(calls[0]?.options, {
			timeout: 2000,
			maxBuffer: 1024 * 1024,
		});
	}
});

test("isPhpStormRunning (linux): ignores stdioMcpServer bridges, unrelated processes, and empty output", async () => {
	const negativeOutputs = [
		// Empty and whitespace-only output
		"",
		"   \n\t\n",
		// Leftover stdioMcpServer bridge variants (bare, quoted, uppercase, java)
		"phpstorm /home/zaher/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm stdioMcpServer\n",
		'phpstorm64 /opt/phpstorm/bin/phpstorm64 "stdioMcpServer"\n',
		"phpstorm /opt/phpstorm/bin/phpstorm 'STDIOMCPSERVER'\n",
		"java /opt/phpstorm/jbr/bin/java -Didea.platform.prefix=PhpStorm com.intellij.idea.Main stdioMcpServer\n",
		// Unrelated processes mentioning phpstorm in arguments
		"node /usr/bin/pi -e ./phpstorm-mcp/index.ts --mode rpc\n",
		"grep grep phpstorm /var/log/syslog\n",
		"vim vim /home/user/phpstorm-notes.md\n",
		"bash /bin/bash -c echo -Didea.platform.prefix=PhpStorm\n",
		// Prefix substring must not match another IDE
		"java /usr/bin/java -Didea.platform.prefix=PhpStormExtra com.intellij.idea.Main\n",
		// Helper binary whose comm is not phpstorm/phpstorm64
		"phpstorm-fsnotifier /opt/phpstorm/bin/fsnotifier\n",
		// Single-column malformed ps line
		"phpstorm\n",
	];

	for (const stdout of negativeOutputs) {
		const { pi } = createExecPi(async () => makeExecResult({ stdout }));
		assert.equal(
			await isPhpStormRunning(pi, "linux"),
			false,
			`Expected false for ps output: ${JSON.stringify(stdout)}`,
		);
	}
});

// ---------------------------------------------------------------------------
// isPhpStormRunning — Windows (win32)
// ---------------------------------------------------------------------------

test("isPhpStormRunning (win32): queries PowerShell by absolute path and parses True/False", async () => {
	const env = { SystemRoot: "D:\\Windows" };
	const runningExec = createExecPi(async () =>
		makeExecResult({ stdout: "True\r\n" }),
	);
	assert.equal(await isPhpStormRunning(runningExec.pi, "win32", env), true);
	assert.equal(
		runningExec.calls[0]?.command,
		"D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	);
	assert.deepEqual(runningExec.calls[0]?.args.slice(0, 4), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
	]);
	const psScript = runningExec.calls[0]?.args[4] ?? "";
	assert.match(psScript, /phpstorm64\.exe/);
	assert.match(psScript, /phpstorm\.exe/);
	assert.match(psScript, /stdioMcpServer/);
	assert.match(psScript, /\$_\.CommandLine/);

	const closedExec = createExecPi(async () =>
		makeExecResult({ stdout: "False\r\n" }),
	);
	assert.equal(await isPhpStormRunning(closedExec.pi, "win32", env), false);

	const emptyExec = createExecPi(async () => makeExecResult({ stdout: "" }));
	await assert.rejects(() => isPhpStormRunning(emptyExec.pi, "win32", env), {
		name: "Error",
		message:
			"Failed to check whether PhpStorm is running: unexpected process query output; MCP was not registered.",
	});
});

// ---------------------------------------------------------------------------
// isPhpStormRunning — error, abort, and unsupported platform handling
// ---------------------------------------------------------------------------

test("isPhpStormRunning: rejects unsupported platforms without invoking pi.exec", async () => {
	const { pi, calls } = createExecPi(async () => makeExecResult());
	await assert.rejects(() => isPhpStormRunning(pi, "freebsd"), {
		name: "Error",
		message:
			"Failed to check whether PhpStorm is running: unsupported platform freebsd; MCP was not registered.",
	});
	assert.equal(calls.length, 0);
});

test("isPhpStormRunning: handles non-zero exit, killed, truncated, thrown errors, and AbortSignal cleanly", async () => {
	const nonZero = createExecPi(async () =>
		makeExecResult({ code: 1, stdout: "true\n", stderr: "failed" }),
	);
	await assert.rejects(() => isPhpStormRunning(nonZero.pi, "darwin"), {
		name: "Error",
		message:
			"Failed to check whether PhpStorm is running: process query failed; MCP was not registered.",
	});

	const killed = createExecPi(async () =>
		makeExecResult({ code: 0, killed: true, stdout: "true\n" }),
	);
	await assert.rejects(() => isPhpStormRunning(killed.pi, "linux"), {
		name: "Error",
		message:
			"Failed to check whether PhpStorm is running: process query failed; MCP was not registered.",
	});

	const truncated = createExecPi(async () =>
		makeExecResult({
			code: 0,
			truncated: true,
			stdout: "phpstorm /bin/phpstorm\n",
		}),
	);
	await assert.rejects(() => isPhpStormRunning(truncated.pi, "linux"), {
		name: "Error",
		message:
			"Failed to check whether PhpStorm is running: process query failed; MCP was not registered.",
	});

	// Underlying error message must not be leaked in the thrown error.
	const thrown = createExecPi(async () => {
		throw new Error("spawn failed with secret-token-value");
	});
	await assert.rejects(
		() => isPhpStormRunning(thrown.pi, "darwin"),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.equal(
				err.message,
				"Failed to check whether PhpStorm is running: could not execute process query; MCP was not registered.",
			);
			assert.equal(err.message.includes("secret-token-value"), false);
			return true;
		},
	);

	// Aborted signal returns false quietly without throwing queryError.
	const controller = new AbortController();
	const abortedExec = createExecPi(async () => {
		controller.abort();
		return makeExecResult({ code: 143, killed: true });
	});
	assert.equal(
		await isPhpStormRunning(
			abortedExec.pi,
			"darwin",
			process.env,
			controller.signal,
		),
		false,
	);
});

// ---------------------------------------------------------------------------
// resolvePhpStormCommand
// ---------------------------------------------------------------------------

test("resolvePhpStormCommand: checks ~/Applications (release & EAP), /Applications (release & EAP), then falls back to ~/Applications", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-phpstorm-apps-"));
	try {
		const fakeHome = join(root, "home");
		const fakeSys = join(root, "sys");
		mkdirSync(fakeHome, { recursive: true });
		mkdirSync(fakeSys, { recursive: true });

		// Fallback when none exist
		assert.equal(
			resolvePhpStormCommand(fakeHome, fakeSys),
			join(
				fakeHome,
				"Applications",
				"PhpStorm.app",
				"Contents",
				"MacOS",
				"phpstorm",
			),
		);

		// System /Applications/PhpStorm EAP.app
		const sysEap = join(
			fakeSys,
			"PhpStorm EAP.app",
			"Contents",
			"MacOS",
			"phpstorm",
		);
		mkdirSync(join(fakeSys, "PhpStorm EAP.app", "Contents", "MacOS"), {
			recursive: true,
		});
		writeFileSync(sysEap, "");
		assert.equal(resolvePhpStormCommand(fakeHome, fakeSys), sysEap);

		// System /Applications/PhpStorm.app takes priority over system EAP
		const sysRel = join(
			fakeSys,
			"PhpStorm.app",
			"Contents",
			"MacOS",
			"phpstorm",
		);
		mkdirSync(join(fakeSys, "PhpStorm.app", "Contents", "MacOS"), {
			recursive: true,
		});
		writeFileSync(sysRel, "");
		assert.equal(resolvePhpStormCommand(fakeHome, fakeSys), sysRel);

		// User ~/Applications/PhpStorm EAP.app takes priority over system
		const homeEap = join(
			fakeHome,
			"Applications",
			"PhpStorm EAP.app",
			"Contents",
			"MacOS",
			"phpstorm",
		);
		mkdirSync(
			join(fakeHome, "Applications", "PhpStorm EAP.app", "Contents", "MacOS"),
			{ recursive: true },
		);
		writeFileSync(homeEap, "");
		assert.equal(resolvePhpStormCommand(fakeHome, fakeSys), homeEap);

		// User ~/Applications/PhpStorm.app takes highest priority
		const homeRel = join(
			fakeHome,
			"Applications",
			"PhpStorm.app",
			"Contents",
			"MacOS",
			"phpstorm",
		);
		mkdirSync(
			join(fakeHome, "Applications", "PhpStorm.app", "Contents", "MacOS"),
			{ recursive: true },
		);
		writeFileSync(homeRel, "");
		assert.equal(resolvePhpStormCommand(fakeHome, fakeSys), homeRel);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// phpstormMcp extension — mode gating, config creation, loading, edge cases
// ---------------------------------------------------------------------------

test("phpstormMcp: non-RPC modes do not probe processes, touch filesystem, or register MCP", async () => {
	await withTempHome(async (tempHome) => {
		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(true),
		);
		// Loading the extension alone must not probe or register.
		assert.equal(harness.sessionStartHandlers.length, 1);
		assert.equal(harness.execCalls.length, 0);
		assert.equal(harness.registered.length, 0);

		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		for (const mode of ["tui", "print", "json"] as const) {
			await handler(makeSessionStartEvent(), makeExtensionContext(mode));
		}

		assert.equal(harness.execCalls.length, 0);
		assert.equal(harness.registered.length, 0);
		assert.equal(existsSync(join(tempHome, ".pi")), false);
	});
});

test("phpstormMcp: closed PhpStorm in RPC mode does not create config or register MCP", async () => {
	await withTempHome(async (tempHome) => {
		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(false),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		await handler(makeSessionStartEvent(), makeExtensionContext("rpc"));

		assert.equal(harness.execCalls.length, 1);
		assert.equal(harness.registered.length, 0);
		assert.equal(existsSync(join(tempHome, ".pi")), false);
	});
});

test("phpstormMcp: session_shutdown aborts in-flight probe and suppresses registration or errors", async () => {
	await withTempHome(async (tempHome) => {
		let capturedSignal: AbortSignal | undefined;
		let releaseProbe!: (res: ExecResult) => void;
		const harness = createExtensionHarness(
			(_cmd, _args, options) =>
				new Promise<ExecResult>((resolve) => {
					capturedSignal = options?.signal;
					releaseProbe = resolve;
				}),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		const startPromise = handler(
			makeSessionStartEvent(),
			makeExtensionContext("rpc"),
		);
		assert.ok(capturedSignal instanceof AbortSignal);
		assert.equal(capturedSignal.aborted, false);

		harness.emitShutdown();
		assert.equal(capturedSignal.aborted, true);

		releaseProbe(runningResultForCurrentPlatform(true));
		await assert.doesNotReject(startPromise);

		assert.equal(harness.registered.length, 0);
		assert.equal(existsSync(join(tempHome, ".pi")), false);
	});
});

test("phpstormMcp: propagates process query failure in RPC mode without creating config or registering", async () => {
	await withTempHome(async (tempHome) => {
		const harness = createExtensionHarness(async () =>
			makeExecResult({ code: 1, stderr: "osascript failed" }),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		await assert.rejects(
			() => handler(makeSessionStartEvent(), makeExtensionContext("rpc")),
			{
				name: "Error",
				message:
					"Failed to check whether PhpStorm is running: process query failed; MCP was not registered.",
			},
		);

		assert.equal(harness.registered.length, 0);
		assert.equal(existsSync(join(tempHome, ".pi")), false);
	});
});

test("phpstormMcp: RPC mode with running PhpStorm creates 0600 config atomically with no leftover .tmp files and registers phpstorm", async () => {
	await withTempHome(async (tempHome) => {
		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(true),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		await handler(makeSessionStartEvent(), makeExtensionContext("rpc"));

		const agentDir = join(tempHome, ".pi", "agent");
		const configPath = join(agentDir, "pi-phpstorm-mcp.json");
		assert.equal(existsSync(configPath), true);

		const entries = readdirSync(agentDir);
		assert.deepEqual(entries, ["pi-phpstorm-mcp.json"]);
		assert.equal(
			entries.some((name) => name.endsWith(".tmp")),
			false,
		);

		if (process.platform !== "win32") {
			assert.equal(statSync(configPath).mode & 0o777, 0o600);
			assert.equal(statSync(agentDir).mode & 0o077, 0);
		}

		const expectedConfig: McpServerConfig = {
			type: "stdio",
			env: {
				IJ_MCP_SERVER_PORT: "64442",
			},
			command: resolvePhpStormCommand(tempHome),
			args: ["stdioMcpServer"],
		};

		const rawOnDisk = readFileSync(configPath, "utf8");
		assert.equal(rawOnDisk, `${JSON.stringify(expectedConfig, null, 2)}\n`);
		assert.deepEqual(harness.registered, [
			{ name: "phpstorm", config: expectedConfig },
		]);
	});
});

test("phpstormMcp: loads existing valid stdio and http configs verbatim without overwriting", async () => {
	const cases: Array<{
		label: string;
		raw: string;
		expected: McpServerConfig;
	}> = [
		{
			label: "explicit stdio config",
			raw: '{"type":"stdio","command":"/Applications/PhpStorm.app/Contents/MacOS/phpstorm","args":["stdioMcpServer"],"env":{"IJ_MCP_SERVER_PORT":"64450"}}',
			expected: {
				type: "stdio",
				command: "/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
				args: ["stdioMcpServer"],
				env: { IJ_MCP_SERVER_PORT: "64450" },
			},
		},
		{
			label: "stdio config with omitted type",
			raw: '{\n  "command": "/opt/phpstorm/bin/phpstorm",\n  "args": ["stdioMcpServer"]\n}',
			expected: {
				command: "/opt/phpstorm/bin/phpstorm",
				args: ["stdioMcpServer"],
			},
		},
		{
			label: "explicit http config",
			raw: '{"type":"http","url":"http://127.0.0.1:64442/mcp","headers":{"X-Custom":"1"}}',
			expected: {
				type: "http",
				url: "http://127.0.0.1:64442/mcp",
				headers: { "X-Custom": "1" },
			},
		},
		{
			label: "http config with omitted type",
			raw: '{"url":"http://127.0.0.1:64442/mcp"}',
			expected: {
				url: "http://127.0.0.1:64442/mcp",
			},
		},
	];

	for (const testCase of cases) {
		await withTempHome(async (tempHome) => {
			const agentDir = join(tempHome, ".pi", "agent");
			const configPath = join(agentDir, "pi-phpstorm-mcp.json");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(configPath, testCase.raw, "utf8");

			const harness = createExtensionHarness(async () =>
				runningResultForCurrentPlatform(true),
			);
			const handler = harness.sessionStartHandlers[0];
			assert.ok(handler !== undefined);

			await handler(makeSessionStartEvent(), makeExtensionContext("rpc"));

			assert.deepEqual(
				harness.registered,
				[{ name: "phpstorm", config: testCase.expected }],
				testCase.label,
			);
			// File must remain byte-for-byte identical (no reformatting or overwrite).
			assert.equal(readFileSync(configPath, "utf8"), testCase.raw);
			assert.deepEqual(readdirSync(agentDir), ["pi-phpstorm-mcp.json"]);
		});
	}
});

test("phpstormMcp: does not overwrite dangling, invalid, or valid symlinks at the config path", async () => {
	// 1. Dangling symlink must fail without creating the target or replacing the symlink.
	await withTempHome(async (tempHome) => {
		const agentDir = join(tempHome, ".pi", "agent");
		const configPath = join(agentDir, "pi-phpstorm-mcp.json");
		const danglingTarget = join(tempHome, "never-create-me.json");
		mkdirSync(agentDir, { recursive: true });
		symlinkSync(danglingTarget, configPath);

		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(true),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		await assert.rejects(
			() => handler(makeSessionStartEvent(), makeExtensionContext("rpc")),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /Failed to load PhpStorm MCP configuration/);
				assert.ok(err.message.includes(configPath));
				return true;
			},
		);

		assert.equal(existsSync(danglingTarget), false);
		assert.equal(lstatSync(configPath).isSymbolicLink(), true);
		assert.equal(readlinkSync(configPath), danglingTarget);
		assert.deepEqual(readdirSync(agentDir), ["pi-phpstorm-mcp.json"]);
		assert.equal(harness.registered.length, 0);
	});

	// 2. Symlink to existing invalid JSON must fail without modifying target or symlink.
	await withTempHome(async (tempHome) => {
		const agentDir = join(tempHome, ".pi", "agent");
		const configPath = join(agentDir, "pi-phpstorm-mcp.json");
		const existingTarget = join(tempHome, "existing-invalid.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(existingTarget, '{"invalid":true}', "utf8");
		symlinkSync(existingTarget, configPath);

		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(true),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		await assert.rejects(
			() => handler(makeSessionStartEvent(), makeExtensionContext("rpc")),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /Failed to load PhpStorm MCP configuration/);
				return true;
			},
		);

		assert.equal(lstatSync(configPath).isSymbolicLink(), true);
		assert.equal(readFileSync(existingTarget, "utf8"), '{"invalid":true}');
		assert.equal(harness.registered.length, 0);
	});

	// 3. Symlink to existing valid config loads verbatim without replacing symlink.
	await withTempHome(async (tempHome) => {
		const agentDir = join(tempHome, ".pi", "agent");
		const configPath = join(agentDir, "pi-phpstorm-mcp.json");
		const validTarget = join(tempHome, "valid-target.json");
		const raw = '{"type":"http","url":"http://127.0.0.1:64442/mcp"}';
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(validTarget, raw, "utf8");
		symlinkSync(validTarget, configPath);

		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(true),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		await handler(makeSessionStartEvent(), makeExtensionContext("rpc"));

		assert.equal(lstatSync(configPath).isSymbolicLink(), true);
		assert.equal(readFileSync(validTarget, "utf8"), raw);
		assert.deepEqual(harness.registered, [
			{
				name: "phpstorm",
				config: { type: "http", url: "http://127.0.0.1:64442/mcp" },
			},
		]);
	});
});

test("phpstormMcp: rejects invalid JSON and invalid config schemas with descriptive errors without clobbering the file", async () => {
	const invalidPayloads: Array<{
		label: string;
		content: string;
		expectInvalidSchema: boolean;
	}> = [
		{
			label: "malformed JSON",
			content: "{ not valid json",
			expectInvalidSchema: false,
		},
		{
			label: "empty object",
			content: "{}",
			expectInvalidSchema: true,
		},
		{
			label: "array root",
			content: "[]",
			expectInvalidSchema: true,
		},
		{
			label: "null root",
			content: "null",
			expectInvalidSchema: true,
		},
		{
			label: "primitive string",
			content: '"phpstorm"',
			expectInvalidSchema: true,
		},
		{
			label: "wrapped mcpServers object",
			content: JSON.stringify({
				mcpServers: { phpstorm: { command: "/usr/bin/phpstorm" } },
			}),
			expectInvalidSchema: true,
		},
		{
			label: "mismatched http type with command",
			content: JSON.stringify({ type: "http", command: "/usr/bin/phpstorm" }),
			expectInvalidSchema: true,
		},
		{
			label: "mismatched stdio type with url",
			content: JSON.stringify({
				type: "stdio",
				url: "http://127.0.0.1:64442/mcp",
			}),
			expectInvalidSchema: true,
		},
		{
			label: "unsupported server type",
			content: JSON.stringify({
				type: "sse",
				url: "http://127.0.0.1:64442/sse",
			}),
			expectInvalidSchema: true,
		},
		{
			label: "non-string command",
			content: JSON.stringify({ type: "stdio", command: 42 }),
			expectInvalidSchema: true,
		},
		{
			label: "empty command",
			content: JSON.stringify({ type: "stdio", command: "   " }),
			expectInvalidSchema: true,
		},
		{
			label: "non-string args entry",
			content: JSON.stringify({
				type: "stdio",
				command: "/usr/bin/phpstorm",
				args: [123],
			}),
			expectInvalidSchema: true,
		},
		{
			label: "non-string env entry",
			content: JSON.stringify({
				type: "stdio",
				command: "/usr/bin/phpstorm",
				env: { PORT: 64442 },
			}),
			expectInvalidSchema: true,
		},
		{
			label: "both command and url present",
			content: JSON.stringify({
				command: "/usr/bin/phpstorm",
				url: "http://127.0.0.1:64442/mcp",
			}),
			expectInvalidSchema: true,
		},
		{
			label: "non-string url",
			content: JSON.stringify({ type: "http", url: 42 }),
			expectInvalidSchema: true,
		},
		{
			label: "empty url",
			content: JSON.stringify({ type: "http", url: "" }),
			expectInvalidSchema: true,
		},
		{
			label: "non-string headers entry",
			content: JSON.stringify({
				type: "http",
				url: "http://127.0.0.1:64442/mcp",
				headers: { Authorization: 123 },
			}),
			expectInvalidSchema: true,
		},
	];

	for (const payload of invalidPayloads) {
		await withTempHome(async (tempHome) => {
			const agentDir = join(tempHome, ".pi", "agent");
			const configPath = join(agentDir, "pi-phpstorm-mcp.json");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(configPath, payload.content, "utf8");

			const harness = createExtensionHarness(async () =>
				runningResultForCurrentPlatform(true),
			);
			const handler = harness.sessionStartHandlers[0];
			assert.ok(handler !== undefined);

			await assert.rejects(
				() => handler(makeSessionStartEvent(), makeExtensionContext("rpc")),
				(err: unknown) => {
					assert.ok(err instanceof Error, payload.label);
					assert.equal(
						err.message,
						`Failed to load PhpStorm MCP configuration from ${configPath}`,
						payload.label,
					);
					if (payload.expectInvalidSchema) {
						assert.ok(err.cause instanceof Error, payload.label);
						assert.equal(
							err.cause.message,
							`Invalid PhpStorm MCP configuration in ${configPath}`,
							payload.label,
						);
					} else {
						assert.ok(err.cause instanceof SyntaxError, payload.label);
					}
					return true;
				},
			);

			// File must never be clobbered.
			assert.equal(readFileSync(configPath, "utf8"), payload.content);
			assert.equal(harness.registered.length, 0);
		});
	}
});

test("phpstormMcp: handles directory at config path and read-only agent directory cleanly", async () => {
	// Directory at config path (EISDIR)
	await withTempHome(async (tempHome) => {
		const configPath = join(tempHome, ".pi", "agent", "pi-phpstorm-mcp.json");
		mkdirSync(configPath, { recursive: true });

		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(true),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);

		await assert.rejects(
			() => handler(makeSessionStartEvent(), makeExtensionContext("rpc")),
			{
				name: "Error",
				message: `Failed to load PhpStorm MCP configuration from ${configPath}`,
			},
		);
		assert.equal(harness.registered.length, 0);
	});

	// Read-only agent directory cannot create temp file (skip if root or Windows)
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		await withTempHome(async (tempHome) => {
			const agentDir = join(tempHome, ".pi", "agent");
			const configPath = join(agentDir, "pi-phpstorm-mcp.json");
			mkdirSync(agentDir, { recursive: true });
			chmodSync(agentDir, 0o500);
			try {
				const harness = createExtensionHarness(async () =>
					runningResultForCurrentPlatform(true),
				);
				const handler = harness.sessionStartHandlers[0];
				assert.ok(handler !== undefined);

				await assert.rejects(
					() => handler(makeSessionStartEvent(), makeExtensionContext("rpc")),
					{
						name: "Error",
						message: `Failed to create default PhpStorm MCP configuration at ${configPath}`,
					},
				);
				assert.deepEqual(readdirSync(agentDir), []);
				assert.equal(harness.registered.length, 0);
			} finally {
				chmodSync(agentDir, 0o700);
			}
		});
	}
});

test("phpstormMcp: respects --no-mcp flag before -- and skips probing or registering MCP", async () => {
	assert.equal(isMcpDisabled(["node", "pi", "--mode", "rpc"]), false);
	assert.equal(isMcpDisabled(["node", "pi", "--no-mcp"]), true);
	assert.equal(isMcpDisabled(["node", "pi", "--", "--no-mcp"]), false);

	const prevArgv = process.argv;
	process.argv = [...prevArgv, "--no-mcp"];
	try {
		const harness = createExtensionHarness(async () =>
			runningResultForCurrentPlatform(true),
		);
		const handler = harness.sessionStartHandlers[0];
		assert.ok(handler !== undefined);
		await handler(makeSessionStartEvent(), makeExtensionContext("rpc"));
		assert.equal(harness.execCalls.length, 0);
		assert.equal(harness.registered.length, 0);
	} finally {
		process.argv = prevArgv;
	}
});
