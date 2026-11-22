import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type RegisteredCommand,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { filterPosthook } from "../rtk-pi-extended/bridge.ts";
import { structureCheck } from "../rtk-pi-extended/policy.ts";
import { resolveExecutable } from "../shared/executable.ts";

interface PackageManifest {
	pi: {
		extensions: string[];
	};
}

const MANIFEST = JSON.parse(
	readFileSync(resolve("package.json"), "utf8"),
) as PackageManifest;
const ALL_EXTENSION_PATHS = MANIFEST.pi.extensions.map((p: string) =>
	resolve(p),
);
const EXPECTED_COMMANDS = [
	"exit",
	"git",
	"progress",
	"rtk-coverage",
	"rtk-gain",
	"trace",
	"wip",
	"workers",
];

function cleanGitEnv(
	overrides: Record<string, string> = {},
): Record<string, string> {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) base[key] = value;
	}
	return {
		...base,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		...overrides,
	};
}

function createTempGitRepo(root: string, env: Record<string, string>): string {
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-b", "main", repo], { env, stdio: "pipe" });
	writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: repo, env, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "initial"], {
		cwd: repo,
		env,
		stdio: "pipe",
	});
	return repo;
}

describe("Pi 1.6 real harness integration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads all 9 extensions together in real createAgentSession with zero errors or collisions and runs full lifecycle", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-sdk-all9-"));
		tempDirs.push(tmp);
		const prevHome = process.env.HOME;
		process.env.HOME = tmp;
		const env = cleanGitEnv({ HOME: tmp });
		const repo = createTempGitRepo(tmp, env);
		const agentDir = join(tmp, "agent");

		const loader = new DefaultResourceLoader({
			cwd: repo,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: ALL_EXTENSION_PATHS,
		});
		await loader.reload();

		const sessionManager = SessionManager.inMemory(repo);
		const { session, extensionsResult } = await createAgentSession({
			cwd: repo,
			agentDir,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			noTools: "builtin",
		});

		const runtimeErrors: ExtensionError[] = [];
		const widgetCalls: Array<{ key: string; active: boolean }> = [];
		const statusCalls: Array<{ key: string; text: string | undefined }> = [];
		try {
			assert.deepEqual(extensionsResult.errors, []);
			const baseUi = session.extensionRunner?.createContext().ui;
			assert.ok(baseUi, "expected base ExtensionUIContext");
			await session.bindExtensions({
				uiContext: {
					...baseUi,
					setWidget(key, content) {
						widgetCalls.push({ key, active: content !== undefined });
					},
					setStatus(key, text) {
						statusCalls.push({ key, text });
					},
				},
				onError: (err: ExtensionError) => runtimeErrors.push(err),
			});
			const runner = session.extensionRunner;
			assert.ok(runner, "expected real ExtensionRunner");
			assert.deepEqual(runner.getCommandDiagnostics(), []);
			assert.deepEqual(runner.getShortcutDiagnostics(), []);
			assert.deepEqual(
				runner
					.getRegisteredCommands()
					.map((c) => c.name)
					.sort(),
				EXPECTED_COMMANDS,
			);
			assert.deepEqual(runner.getActiveTools().sort(), ["progress"]);
			assert.ok(runner.getEntryRenderer("git-output"));

			// Enable progress via /progress start, mutate via wrapped progress tool, verify prompt injection.
			const progressCmd = runner.getCommand("progress");
			assert.ok(progressCmd);
			await progressCmd.handler("start", runner.createCommandContext());
			const registeredProgress = runner
				.getAllRegisteredTools()
				.find((t) => t.definition.name === "progress");
			assert.ok(registeredProgress);
			const wrappedProgress = wrapRegisteredTool(registeredProgress, runner);
			await wrappedProgress.execute("prog-1", {
				action: "add_task",
				expected_revision: 0,
				title: "Verify Pi harness",
				description: "Confirm real SDK tool + prompt injection",
				steps: ["Execute wrapped tool"],
			});
			assert.equal(
				existsSync(
					join(tmp, ".config", "ai-sessions", "repo", "progress.json"),
				),
				true,
			);
			const beforeWithProgress = await runner.emitBeforeAgentStart(
				{ messageType: "user", prompt: "continue" },
				{
					cwd: repo,
					selectedTools: ["progress"],
					toolSnippets: {},
					promptGuidelines: [],
					contextFiles: [],
					skills: [],
				},
			);
			assert.equal(beforeWithProgress.messages.length, 1);
			assert.equal(
				beforeWithProgress.messages[0]?.customType,
				"progress-context",
			);

			// tool_result chaining through real ExtensionRunner (read dedup + subagent widget)
			const fileLines = Array.from(
				{ length: 40 },
				(_, i) =>
					`export const line${String(i + 1).padStart(2, "0")} = "payload-for-real-dedup-${i}";`,
			).join("\n");
			assert.equal(
				await runner.emitToolResult({
					type: "tool_result",
					toolCallId: "read-1",
					toolName: "read",
					input: { path: "src/app.ts" },
					content: [{ type: "text", text: fileLines }],
					details: undefined,
					isError: false,
				}),
				undefined,
			);
			const readEntryId = sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: fileLines }],
				isError: false,
				timestamp: Date.now(),
			});
			const secondRead = await runner.emitToolResult({
				type: "tool_result",
				toolCallId: "read-2",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: fileLines }],
				details: undefined,
				isError: false,
			});
			assert.ok(secondRead?.content);

			await runner.emit({
				type: "tool_execution_start",
				toolCallId: "sub-1",
				toolName: "subagent",
				args: { task: "check diff" },
			});
			await runner.emit({
				type: "tool_execution_end",
				toolCallId: "sub-1",
				toolName: "subagent",
				result: {
					content: [{ type: "text", text: "done" }],
					details: {
						mode: "workflow",
						results: [],
						workflowChildren: {
							version: 1,
							workflowState: "completed",
							children: [
								{
									agent: "reviewer",
									task: "check diff",
									stopReason: "stop",
									state: "completed",
								},
							],
						},
					},
				},
				isError: false,
			});
			assert.ok(widgetCalls.some((c) => c.key === "worker-board" && c.active));

			// Turn boundary + shutdown lifecycle
			const assistantMsg = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "done" }],
				api: "openai-responses" as const,
				provider: "openai" as const,
				model: "gpt-5",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			const assistantEntryId = sessionManager.appendMessage(assistantMsg);
			const boundary = await runner.emitBoundary(
				{
					type: "turn_end",
					turnIndex: 0,
					message: assistantMsg,
					toolResults: [],
					messageEntryId: assistantEntryId,
					toolResultEntryIds: [readEntryId],
					outcome: "completed",
				},
				() => ({
					contextEntries: sessionManager.buildSessionProjection().entries,
					contextMessages: sessionManager.buildSessionContext().messages,
					llmMessages: [],
					pendingMessages: [],
					canContinue: true,
				}),
			);
			assert.equal(boundary.valid, true);
			assert.ok(
				boundary.entries.some(
					(e) => "customType" in e && e.customType === "rtk-pi-extended",
				),
			);

			await runner.emit({ type: "session_shutdown", reason: "quit" });
			assert.ok(widgetCalls.some((c) => c.key === "worker-board" && !c.active));
			assert.ok(
				statusCalls.some((c) => c.key === "rtk-gain" && c.text === undefined),
			);
			assert.deepEqual(runtimeErrors, []);
		} finally {
			await session.dispose();
			await new Promise((r) => setTimeout(r, 30));
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});

	it("filters and recalls byte-for-byte against the real installed rtk binary across all 3 bundled profiles and parses live rtk gain JSON", {
		skip: !resolveExecutable("rtk") ? "rtk binary not on PATH" : false,
	}, async () => {
		const isolatedHome = mkdtempSync(join(tmpdir(), "pi-rtk-live-"));
		tempDirs.push(isolatedHome);
		const rtkEnv = {
			...process.env,
			HOME: isolatedHome,
			XDG_DATA_HOME: join(isolatedHome, "data"),
			XDG_CONFIG_HOME: join(isolatedHome, "config"),
		};

		const cases: Array<{
			tool: string;
			profile: "terminal" | "listing" | "generic";
			input: string;
		}> = [
			{
				tool: "bash",
				profile: "terminal",
				input: `${Array.from(
					{ length: 120 },
					() =>
						"\x1b[32mPASS\x1b[0m src/foo.test.ts: repeated status output line with padding 0123456789",
				).join("\n")}\nDone.\n`,
			},
			{
				tool: "grep",
				profile: "listing",
				input: `src/big-file.ts\n${Array.from(
					{ length: 360 },
					(_, i) => ` ${i + 1}: const match${i} = computeValue(${i});`,
				).join("\n")}\n`,
			},
			{
				tool: "custom_tool",
				profile: "generic",
				input: `${Array.from(
					{ length: 120 },
					() =>
						'{"status":"ok","payload":"repeated generic line for dedup test 0123456789"}',
				).join("\n")}\nDone.\n`,
			},
		];

		for (const c of cases) {
			const res = await filterPosthook(
				c.tool,
				c.input,
				{
					configDirectory: resolve(`rtk-pi-extended/rtk/${c.profile}`),
					env: rtkEnv,
				},
				structureCheck(c.profile),
				true,
			);
			assert.equal(res.kind, "filtered");
			assert.ok(res.text.length < c.input.length);
		}

		const rtkBin = resolveExecutable("rtk");
		assert.ok(rtkBin);
		const gainRaw = execFileSync(rtkBin, ["gain", "--format", "json"], {
			encoding: "utf8",
			env: rtkEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const gainParsed = JSON.parse(gainRaw) as {
			summary?: Record<string, unknown>;
		};
		assert.ok(gainParsed.summary && typeof gainParsed.summary === "object");
		for (const key of [
			"total_commands",
			"total_input",
			"total_output",
			"total_saved",
		]) {
			assert.equal(Number.isSafeInteger(gainParsed.summary[key]), true);
		}
	});

	it("runs progress background updater end-to-end through real ModelRegistry.streamSimple over loopback HTTP SSE and disposes mid-flight safely", async () => {
		const proposal = JSON.stringify({
			tasks: [
				{
					id: null,
					title: "Live streamSimple task",
					description: "Created over HTTP SSE",
					steps: [
						{
							id: null,
							description: "Verify end-to-end streamSimple",
							status: "completed",
							blocked_by: null,
						},
					],
				},
			],
		});

		let slowMode = false;
		const sockets = new Set<Socket>();
		const server = createServer((req, res) => {
			req.on("data", () => {});
			req.on("end", () => {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				});
				if (slowMode) {
					const timer = setTimeout(() => {
						res.write("data: [DONE]\n\n");
						res.end();
					}, 250);
					res.on("close", () => clearTimeout(timer));
					return;
				}
				const now = Math.floor(Date.now() / 1000);
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion.chunk",
						created: now,
						model: "progress-test",
						choices: [
							{
								index: 0,
								delta: { role: "assistant", content: proposal },
								finish_reason: null,
							},
						],
					})}\n\n`,
				);
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion.chunk",
						created: now,
						model: "progress-test",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: {
							prompt_tokens: 42,
							completion_tokens: 18,
							total_tokens: 60,
						},
					})}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});
		server.on("connection", (sock) => {
			sockets.add(sock);
			sock.on("close", () => sockets.delete(sock));
		});
		await new Promise<void>((resolveListen) =>
			server.listen(0, "127.0.0.1", () => resolveListen()),
		);
		const { port } = server.address() as AddressInfo;

		const tmp = mkdtempSync(join(tmpdir(), "pi-bg-sse-"));
		tempDirs.push(tmp);
		const prevHome = process.env.HOME;
		process.env.HOME = tmp;
		const unhandled: unknown[] = [];
		const onRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onRejection);

		try {
			const agentDir = join(tmp, "agent");
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "local-sse",
				defaultModel: "progress-test",
			});
			const loader = new DefaultResourceLoader({
				cwd: tmp,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: ALL_EXTENSION_PATHS,
			});
			await loader.reload();

			const sessionManager = SessionManager.inMemory(tmp);
			const { session, extensionsResult } = await createAgentSession({
				cwd: tmp,
				agentDir,
				resourceLoader: loader,
				sessionManager,
				settingsManager,
				noTools: "builtin",
			});
			assert.deepEqual(extensionsResult.errors, []);

			const runtimeErrors: ExtensionError[] = [];
			await session.bindExtensions({
				onError: (err: ExtensionError) => runtimeErrors.push(err),
			});
			const runner = session.extensionRunner;
			assert.ok(runner);
			runner.createContext().modelRegistry.registerProvider("local-sse", {
				baseUrl: `http://127.0.0.1:${port}/v1`,
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "progress-test",
						name: "Progress Test",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			const progressCmd = runner.getCommand("progress");
			assert.ok(progressCmd);
			await progressCmd.handler("start", runner.createCommandContext());
			sessionManager.appendMessage({
				role: "user",
				content: "Please verify streamSimple end-to-end.",
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Verified." }],
				api: "openai-completions",
				provider: "local-sse",
				model: "progress-test",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});

			await runner.emit({ type: "agent_settled", aborted: false });
			await runner.emit({ type: "session_shutdown", reason: "quit" });

			const savedPath = join(
				tmp,
				".config",
				"ai-sessions",
				basename(tmp),
				"progress.json",
			);
			const saved = JSON.parse(readFileSync(savedPath, "utf8")) as {
				revision: number;
				tasks: Array<{ title: string }>;
			};
			assert.equal(saved.revision, 1);
			assert.equal(saved.tasks[0]?.title, "Live streamSimple task");

			// Now verify mid-flight session.dispose() does not cause unhandled rejections
			slowMode = true;
			await runner.emit({ type: "session_start", reason: "new" });
			await runner.emit({ type: "agent_settled", aborted: false });
			await runner.emit({ type: "session_shutdown", reason: "new" });
			await session.dispose();
			await new Promise((r) => setTimeout(r, 60));

			assert.deepEqual(runtimeErrors, []);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onRejection);
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			for (const sock of sockets) sock.destroy();
			await new Promise<void>((resolveClose) =>
				server.close(() => resolveClose()),
			);
		}
	});

	it("enforces stale-entry, mid-flight-disposal, and headless stderr contracts across all 9 extensions", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-ctx-contract-"));
		tempDirs.push(tmp);
		const prevHome = process.env.HOME;
		process.env.HOME = tmp;

		type CommandDef = Omit<RegisteredCommand, "name" | "sourceInfo">;
		type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

		const staleError = (): never => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload",
			);
		};
		const staleCtx = new Proxy({} as ExtensionCommandContext, {
			get() {
				return staleError();
			},
		});

		const stderrChunks: string[] = [];
		const origStderrWrite = process.stderr.write.bind(process.stderr);
		const origConsoleError = console.error;
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			stderrChunks.push(
				typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
			);
			return true;
		}) as typeof process.stderr.write;
		console.error = (...args: unknown[]): void => {
			stderrChunks.push(`${args.map(String).join(" ")}\n`);
		};

		try {
			const factories = await Promise.all(
				ALL_EXTENSION_PATHS.map(async (extPath) => {
					const mod = (await import(pathToFileURL(extPath).href)) as {
						default: (pi: ExtensionAPI) => void;
					};
					return { path: extPath, init: mod.default };
				}),
			);

			let execDelay: Promise<void> | undefined;
			const registerAll = () => {
				const commands = new Map<string, CommandDef>();
				const tools = new Map<string, ToolDefinition>();
				const events = new Map<string, EventHandler[]>();
				const host = {
					registerCommand(name: string, def: CommandDef): void {
						commands.set(name, def);
					},
					registerTool(def: ToolDefinition): void {
						tools.set(def.name, def);
					},
					on(event: string, handler: EventHandler): () => void {
						const list = events.get(event) ?? [];
						list.push(handler);
						events.set(event, list);
						return () => {};
					},
					registerEntryRenderer(): void {},
					registerMcpServer(): void {},
					appendEntry(): void {},
					getSettings() {
						return {};
					},
					async exec() {
						if (execDelay) await execDelay;
						return {
							code: 0,
							stdout: JSON.stringify({
								summary: {
									total_commands: 1,
									total_input: 200,
									total_output: 100,
									total_saved: 100,
								},
							}),
							stderr: "",
							killed: false,
							truncated: false,
						};
					},
				} as unknown as ExtensionAPI;
				for (const { init } of factories) init(host);
				return { commands, tools, events };
			};

			// Case 1: stale-at-entry across all registered commands, tools, and event hooks
			const staleReg = registerAll();
			for (const [name, cmd] of staleReg.commands) {
				await assert.doesNotReject(
					async () => cmd.handler("", staleCtx),
					`command /${name} threw on stale-at-entry context`,
				);
			}
			const sampleEvents: Record<string, unknown> = {
				session_start: { type: "session_start", reason: "new" },
				session_shutdown: { type: "session_shutdown", reason: "new" },
				session_tree: { type: "session_tree" },
				session_compact: { type: "session_compact" },
				input: { type: "input", text: "hi" },
				before_agent_start: {
					type: "before_agent_start",
					messageType: "user",
					prompt: "hi",
				},
				turn_start: { type: "turn_start" },
				turn_end: {
					type: "turn_end",
					turnIndex: 0,
					toolResults: [{}],
					toolResultEntryIds: [],
					outcome: "completed",
				},
				agent_end: { type: "agent_end" },
				agent_settled: { type: "agent_settled", aborted: false },
				tool_execution_start: {
					type: "tool_execution_start",
					toolCallId: "t1",
					toolName: "subagent",
					args: { task: "x" },
				},
				tool_execution_update: {
					type: "tool_execution_update",
					toolCallId: "t1",
					toolName: "subagent",
					partialResult: {},
				},
				tool_execution_end: {
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: "subagent",
					result: {},
					isError: false,
				},
				tool_result: {
					type: "tool_result",
					toolCallId: "r1",
					toolName: "bash",
					input: { command: "echo ok" },
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			};
			for (const [eventName, handlers] of staleReg.events) {
				const payload = sampleEvents[eventName] ?? { type: eventName };
				for (const handler of handlers) {
					const result = await handler(payload, staleCtx);
					if (eventName === "before_agent_start") {
						assert.equal(
							result,
							undefined,
							"before_agent_start must not inject bogus IO_ERROR on stale context",
						);
					}
				}
			}
			for (const [toolName, tool] of staleReg.tools) {
				await assert.rejects(
					async () =>
						tool.execute(
							"call-1",
							{ action: "read" },
							undefined,
							undefined,
							staleCtx as unknown as Parameters<typeof tool.execute>[4],
						),
					(err: unknown) => err instanceof Error && err.name === "AbortError",
					`tool ${toolName} must reject with AbortError (not IO_ERROR or raw stale error) on stale context`,
				);
			}
			assert.deepEqual(
				stderrChunks,
				[],
				"stale-at-entry must write nothing to stderr",
			);

			// Case 2: mid-flight disposal on an interactive (hasUI: true) session never leaks to stderr
			const midReg = registerAll();
			let disposed = false;
			const sessionDir = join(tmp, "sessions");
			const liveBase = {
				cwd: tmp,
				hasUI: true,
				mode: "tui",
				signal: undefined,
				isIdle: () => true,
				shutdown: () => {},
				ui: {
					notify(): void {
						if (disposed) staleError();
					},
					setStatus(): void {
						if (disposed) staleError();
					},
					setWidget(): void {
						if (disposed) staleError();
					},
				},
				sessionManager: {
					getSessionId: () => "s1",
					getSessionDir: () => sessionDir,
					getLeafId: () => null,
					getBranch: () => [],
					buildSessionProjection: () => ({ entries: [], messages: [] }),
				},
			};
			const midCtx = new Proxy(liveBase as unknown as ExtensionCommandContext, {
				get(target, prop, receiver) {
					if (disposed) return staleError();
					return Reflect.get(target, prop, receiver);
				},
			});
			let releaseExec!: () => void;
			execDelay = new Promise<void>((r) => {
				releaseExec = r;
			});
			const inflightGain = midReg.commands.get("rtk-gain")?.handler("", midCtx);
			disposed = true;
			releaseExec();
			await inflightGain;
			execDelay = undefined;
			assert.deepEqual(
				stderrChunks,
				[],
				"disposed interactive session must never dump UI notifications onto stderr",
			);

			// Case 3: active headless (hasUI: false) session routes command diagnostics to stderr
			const headlessReg = registerAll();
			const headlessCtx = {
				...liveBase,
				hasUI: false,
				mode: "json",
			} as unknown as ExtensionCommandContext;
			await headlessReg.commands.get("rtk-gain")?.handler("invalid", headlessCtx);
			await headlessReg.commands
				.get("rtk-coverage")
				?.handler("invalid", headlessCtx);
			await headlessReg.commands.get("progress")?.handler("invalid", headlessCtx);
			assert.equal(stderrChunks.length, 3);
		} finally {
			process.stderr.write = origStderrWrite;
			console.error = origConsoleError;
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});
});
