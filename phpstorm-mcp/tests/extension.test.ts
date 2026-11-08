import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	McpServerConfig,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import phpstormMcp from "../index.ts";

type SessionStartHandler = ExtensionHandler<SessionStartEvent>;

let configPath: string;

beforeEach((t) => {
	assert.ok("after" in t);
	const home = mkdtempSync(fileURLToPath(new URL(".home-", import.meta.url)));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	configPath = join(home, ".pi", "agent", "pi-phpstorm-mcp.json");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
});

const runningOutput = process.platform === "linux" ? "phpstorm /opt/phpstorm/bin/phpstorm\n" : "true\n";
const stoppedOutput = process.platform === "linux" ? "node node pi-acp\n" : "false\n";
const success = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false, truncated: false });

function loadExtension(exec: ExtensionAPI["exec"] = async () => success(runningOutput)) {
	const handlers = new Map<string, SessionStartHandler[]>();
	const registrations: { name: string; config: McpServerConfig }[] = [];
	const checks: Parameters<ExtensionAPI["exec"]>[] = [];

	// Only the Pi API members used by this extension are needed in the fixture.
	const pi: Pick<ExtensionAPI, "on" | "registerMcpServer" | "exec"> = {
		on(event, handler) {
			assert.equal(event, "session_start");
			const callbacks = handlers.get(event) ?? [];
			callbacks.push(handler as SessionStartHandler);
			handlers.set(event, callbacks);
			return () => {
				handlers.set(event, callbacks.filter((callback) => callback !== handler));
			};
		},
		registerMcpServer(name, config) {
			registrations.push({ name, config });
		},
		async exec(...args) {
			checks.push(args);
			return exec(...args);
		},
	};
	phpstormMcp(pi as ExtensionAPI);

	return {
		registrations,
		checks,
		async startSession(mode: ExtensionContext["mode"]) {
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "startup" }, { mode } as ExtensionContext);
			}
		},
	};
}

test("registers the JSON-configured PhpStorm server in an RPC session", async () => {
	writeFileSync(configPath, JSON.stringify({
		type: "stdio",
		env: { IJ_MCP_SERVER_PORT: "54321" },
		command: "/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
		args: ["stdioMcpServer"],
		timeout: 90,
	}));
	const extension = loadExtension();
	await extension.startSession("rpc");

	assert.deepEqual(extension.registrations, [
		{
			name: "phpstorm",
			config: {
				type: "stdio",
				env: { IJ_MCP_SERVER_PORT: "54321" },
				command: "/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
				args: ["stdioMcpServer"],
				timeout: 90,
			},
		},
	]);
});

test("reads changed configuration on the next session start", async () => {
	writeFileSync(configPath, JSON.stringify({ command: "first-phpstorm" }));
	const extension = loadExtension();
	await extension.startSession("rpc");
	writeFileSync(configPath, JSON.stringify({ command: "second-phpstorm" }));
	await extension.startSession("rpc");

	assert.deepEqual(extension.registrations.map(({ config }) => config), [
		{ command: "first-phpstorm" },
		{ command: "second-phpstorm" },
	]);
});

test("uses the original defaults when the configuration file is missing", async () => {
	const extension = loadExtension();
	await extension.startSession("rpc");

	assert.deepEqual(extension.registrations, [{
		name: "phpstorm",
		config: {
			type: "stdio",
			env: { IJ_MCP_SERVER_PORT: "64442" },
			command: "/Users/zaher/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
			args: ["stdioMcpServer"],
		},
	}]);
});

for (const scenario of ["malformed", "unreadable"]) {
	test(`reports the config path for ${scenario} configuration without registering`, async () => {
		if (scenario === "malformed") writeFileSync(configPath, "{ invalid json");
		if (scenario === "unreadable") mkdirSync(configPath);
		const extension = loadExtension();

		await assert.rejects(extension.startSession("rpc"), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(configPath));
			return true;
		});
		assert.deepEqual(extension.registrations, []);
	});
}

for (const mode of ["tui", "print", "json"] as const) {
	test(`does not read config or register PhpStorm in ${mode} mode`, async () => {
		writeFileSync(configPath, "{ invalid json");
		const extension = loadExtension();
		await extension.startSession(mode);

		assert.deepEqual(extension.registrations, []);
		assert.deepEqual(extension.checks, []);
	});
}

test("does not inspect processes, read config, or register during extension discovery", () => {
	writeFileSync(configPath, "{ invalid json");
	const extension = loadExtension();
	assert.deepEqual(extension.registrations, []);
	assert.deepEqual(extension.checks, []);
});

test("skips configuration and registration when PhpStorm is closed", async () => {
	writeFileSync(configPath, "{ invalid json");
	const extension = loadExtension(async () => success(stoppedOutput));
	await extension.startSession("rpc");
	assert.equal(extension.checks.length, 1);
	assert.deepEqual(extension.registrations, []);
});

test("checks again on the next session after PhpStorm opens", async () => {
	let running = false;
	const extension = loadExtension(async () => success(running ? runningOutput : stoppedOutput));
	await extension.startSession("rpc");
	assert.deepEqual(extension.registrations, []);
	running = true;
	await extension.startSession("rpc");
	assert.equal(extension.checks.length, 2);
	assert.equal(extension.registrations.length, 1);
});

test("refuses registration when the running-application query fails", async () => {
	const extension = loadExtension(async () => ({ ...success(""), code: 1, stderr: "private process details" }));
	await assert.rejects(extension.startSession("rpc"), {
		message: "Failed to check whether PhpStorm is running: process query failed; MCP was not registered.",
	});
	assert.deepEqual(extension.registrations, []);
});
