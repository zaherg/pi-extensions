import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPhpStormRunning } from "../running.ts";

const success = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false, truncated: false });

for (const platform of ["darwin", "linux", "win32"] as const) {
	test(`${platform}: bounds the process query and does not invoke an IDE executable`, async () => {
		const calls: Parameters<ExtensionAPI["exec"]>[] = [];
		const running = await isPhpStormRunning({
			async exec(...args) {
				calls.push(args);
				return success(platform === "linux" ? "" : "False\r\n");
			},
		}, platform);
		assert.equal(running, false);
		assert.equal(calls.length, 1);
		const [command, args, options] = calls[0];
		assert.deepEqual(options, { timeout: 2000, maxBuffer: 1024 * 1024 });
		if (platform === "darwin") {
			assert.equal(command, "/usr/bin/osascript");
			assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
		} else if (platform === "linux") {
			assert.equal(command, "ps");
			assert.deepEqual(args, ["-Aww", "-o", "comm=", "-o", "args="]);
		} else {
			assert.equal(command, "powershell.exe");
			assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
			assert.match(args[4], /Get-CimInstance Win32_Process/);
			assert.match(args[4], /CommandLine -notmatch/);
		}
	});
}

test("macOS query requires a live regular PhpStorm application, not a bridge", async () => {
	for (const [apps, expected] of [
		[[], false],
		[[{ terminated: false, activationPolicy: "0" }], true],
		[[{ terminated: true, activationPolicy: "0" }], false],
		[[{ terminated: false, activationPolicy: "1" }], false],
		[[{ terminated: false, activationPolicy: "2" }], false],
		[[{ terminated: true, activationPolicy: "0" }, { terminated: false, activationPolicy: 0 }], true],
	] as const) {
		const running = await isPhpStormRunning({
			async exec(_command, args) {
				const output = runInNewContext(args[3], {
					ObjC: { import: (name: string) => assert.equal(name, "AppKit") },
					$: {
						NSRunningApplication: {
							runningApplicationsWithBundleIdentifier(id: string) {
								assert.equal(id, "com.jetbrains.PhpStorm");
								return { count: String(apps.length), objectAtIndex: (i: number) => apps[i] };
							},
						},
					},
				}, { timeout: 1000 });
				return success(`${output}\n`);
			},
		}, "darwin");
		assert.equal(running, expected);
	}
});

test("Linux query accepts native and JVM IDEs but excludes bridges and unrelated mentions", async () => {
	for (const [stdout, expected] of [
		["phpstorm /opt/PhpStorm/bin/phpstorm\n", true],
		[" phpstorm64 /home/user/JetBrains Toolbox/phpstorm/bin/phpstorm64 project\n", true],
		["java /opt/phpstorm/jbr/bin/java -Didea.platform.prefix=PhpStorm com.intellij.idea.Main\n", true],
		["phpstorm /opt/phpstorm/bin/phpstorm stdioMcpServer\n", false],
		["phpstorm64 /opt/phpstorm/bin/phpstorm64 \"stdioMcpServer\"\n", false],
		["java java -Didea.platform.prefix=PhpStorm com.intellij.idea.Main stdioMcpServer\n", false],
		["node node pi-acp /opt/phpstorm/bin/phpstorm\n", false],
		["grep grep -Didea.platform.prefix=PhpStorm\n", false],
		["java java -Didea.platform.prefix=PhpStormOther\n", false],
		["java java -Didea.platform.prefix=Other\n", false],
		["java java\n", false],
		["", false],
		["node node pi-acp\nphpstorm /opt/phpstorm/bin/phpstorm stdioMcpServer\nphpstorm /opt/phpstorm/bin/phpstorm\n", true],
	] as const) {
		assert.equal(await isPhpStormRunning({ exec: async () => success(stdout) }, "linux"), expected, stdout);
	}
});

test("macOS and Windows require explicit boolean query results", async () => {
	for (const platform of ["darwin", "win32"] as const) {
		assert.equal(await isPhpStormRunning({ exec: async () => success("True\r\n") }, platform), true);
		assert.equal(await isPhpStormRunning({ exec: async () => success("false\n") }, platform), false);
		for (const output of ["", "true\nfalse", "private process details"]) {
			await assert.rejects(isPhpStormRunning({ exec: async () => success(output) }, platform), {
				message: "Failed to check whether PhpStorm is running: unexpected process query output; MCP was not registered.",
			});
		}
	}
});

test("failed, timed-out, and truncated process queries refuse positive partial output", async () => {
	for (const platform of ["darwin", "linux", "win32"] as const) {
		for (const failure of [{ code: 1 }, { killed: true }, { truncated: true }]) {
			await assert.rejects(isPhpStormRunning({
				exec: async () => ({
					...success(platform === "linux" ? "phpstorm /opt/phpstorm/bin/phpstorm\n" : "true\n"),
					stderr: "private process details",
					...failure,
				}),
			}, platform), {
				message: "Failed to check whether PhpStorm is running: process query failed; MCP was not registered.",
			});
		}
	}
});

test("execution exceptions do not leak process arguments or output", async () => {
	await assert.rejects(isPhpStormRunning({
		exec: async () => { throw new Error("private process details"); },
	}, "darwin"), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "Failed to check whether PhpStorm is running: could not execute process query; MCP was not registered.");
		assert.equal(error.cause, undefined);
		return true;
	});
});

test("unsupported platforms refuse registration without executing anything", async () => {
	await assert.rejects(isPhpStormRunning({
		exec: async () => { assert.fail("must not execute"); },
	}, "freebsd"), /unsupported platform freebsd/);
});
