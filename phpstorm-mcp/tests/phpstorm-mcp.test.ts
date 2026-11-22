import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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

function runningOutput(running: boolean): ExecResult {
	if (process.platform === "linux") {
		return makeExec(
			running ? "phpstorm /opt/phpstorm/bin/phpstorm\n" : "node /usr/bin/pi\n",
		);
	}
	if (process.platform === "win32") {
		return makeExec(running ? "True\r\n" : "False\r\n");
	}
	return makeExec(running ? "true\n" : "false\n");
}

function createHarness(
	execImpl: (
		cmd: string,
		args: string[],
		opts?: ExecOptions,
	) => Promise<ExecResult>,
) {
	let onStart:
		| ((ev: SessionStartEvent, ctx: ExtensionContext) => Promise<void>)
		| undefined;
	const registered: Array<{ name: string; config: McpServerConfig }> = [];
	let execCount = 0;

	phpstormMcp({
		on(event: string, fn: unknown) {
			if (event === "session_start") {
				onStart = fn as (
					ev: SessionStartEvent,
					ctx: ExtensionContext,
				) => Promise<void>;
			}
		},
		exec(cmd: string, args: string[], opts?: ExecOptions) {
			execCount += 1;
			return execImpl(cmd, args, opts);
		},
		registerMcpServer(name: string, config: McpServerConfig) {
			registered.push({ name, config });
		},
	} as unknown as ExtensionAPI);

	return {
		registered,
		getExecCount: () => execCount,
		start: async (mode: ExtensionContext["mode"]) => {
			assert.ok(onStart);
			await onStart(
				{ type: "session_start" } as unknown as SessionStartEvent,
				{ mode } as unknown as ExtensionContext,
			);
		},
	};
}

describe("isPhpStormRunning & platform helpers", () => {
	it("detects running PhpStorm across darwin, linux (ignoring stdioMcpServer), and win32", async () => {
		assert.equal(
			windowsPowerShell({
				SystemRoot: "\\\\attacker\\share",
				windir: "D:\\Windows",
			}),
			"D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);

		assert.equal(
			await isPhpStormRunning(
				{ exec: async () => makeExec("true\n") },
				"darwin",
			),
			true,
		);
		assert.equal(
			await isPhpStormRunning(
				{ exec: async () => makeExec("false\n") },
				"darwin",
			),
			false,
		);

		assert.equal(
			await isPhpStormRunning(
				{
					exec: async () =>
						makeExec(
							"java /opt/phpstorm/jbr/bin/java -Didea.platform.prefix=PhpStorm com.intellij.idea.Main\n",
						),
				},
				"linux",
			),
			true,
		);
		assert.equal(
			await isPhpStormRunning(
				{
					exec: async () =>
						makeExec("phpstorm /opt/phpstorm/bin/phpstorm stdioMcpServer\n"),
				},
				"linux",
			),
			false,
		);

		assert.equal(
			await isPhpStormRunning(
				{ exec: async () => makeExec("True\r\n") },
				"win32",
				{ SystemRoot: "C:\\Windows" },
			),
			true,
		);
	});

	it("resolves PhpStorm binary precedence across ~/Applications and /Applications", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ps-apps-"));
		try {
			const home = join(root, "home");
			const sys = join(root, "sys");
			const sysEap = join(
				sys,
				"PhpStorm EAP.app",
				"Contents",
				"MacOS",
				"phpstorm",
			);
			mkdirSync(join(sys, "PhpStorm EAP.app", "Contents", "MacOS"), {
				recursive: true,
			});
			writeFileSync(sysEap, "");
			assert.equal(resolvePhpStormCommand(home, sys), sysEap);

			const homeRel = join(
				home,
				"Applications",
				"PhpStorm.app",
				"Contents",
				"MacOS",
				"phpstorm",
			);
			mkdirSync(
				join(home, "Applications", "PhpStorm.app", "Contents", "MacOS"),
				{
					recursive: true,
				},
			);
			writeFileSync(homeRel, "");
			assert.equal(resolvePhpStormCommand(home, sys), homeRel);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("phpstormMcp registration & config safety", () => {
	it("gates on RPC mode and --no-mcp, creates atomic 0600 config, preserves existing config, and refuses symlinks", async () => {
		assert.equal(isMcpDisabled(["node", "pi", "--no-mcp"]), true);
		assert.equal(isMcpDisabled(["node", "pi", "--", "--no-mcp"]), false);

		const tempHome = mkdtempSync(join(tmpdir(), "pi-ps-home-"));
		const prevHome = process.env.HOME;
		process.env.HOME = tempHome;
		try {
			// Non-RPC modes never probe or write config
			const tui = createHarness(async () => runningOutput(true));
			await tui.start("tui");
			assert.equal(tui.getExecCount(), 0);
			assert.equal(existsSync(join(tempHome, ".pi")), false);

			// RPC mode with running PhpStorm creates 0600 default config & registers
			const rpc = createHarness(async () => runningOutput(true));
			await rpc.start("rpc");
			const cfgPath = join(tempHome, ".pi", "agent", "pi-phpstorm-mcp.json");
			assert.equal(existsSync(cfgPath), true);
			if (process.platform !== "win32") {
				assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
			}
			assert.equal(rpc.registered.length, 1);
			assert.equal(rpc.registered[0]?.name, "phpstorm");

			// Existing custom config is loaded verbatim without overwriting
			const customRaw = '{"type":"http","url":"http://127.0.0.1:64442/mcp"}';
			writeFileSync(cfgPath, customRaw, "utf8");
			const existing = createHarness(async () => runningOutput(true));
			await existing.start("rpc");
			assert.equal(readFileSync(cfgPath, "utf8"), customRaw);
			assert.deepEqual(existing.registered[0]?.config, {
				type: "http",
				url: "http://127.0.0.1:64442/mcp",
			});

			// Symlink at config path is refused without touching target
			rmSync(cfgPath);
			const target = join(tempHome, "outside.json");
			symlinkSync(target, cfgPath);
			const sym = createHarness(async () => runningOutput(true));
			await assert.rejects(
				() => sym.start("rpc"),
				/Failed to load PhpStorm MCP/,
			);
			assert.equal(lstatSync(cfgPath).isSymbolicLink(), true);
			assert.equal(existsSync(target), false);
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
