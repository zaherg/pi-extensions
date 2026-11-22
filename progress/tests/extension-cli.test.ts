import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	AgentSettledEvent,
	AgentToolResult,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	SessionEntry,
	SessionShutdownEvent,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import progressExtension from "../index.ts";
import {
	MAX_BYTES,
	type ProgressResult,
	progressPath,
	runProgress,
} from "../store.ts";

const CLI_PATH = resolve("progress/cli.ts");

interface CliOutput {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runCli(
	args: readonly string[],
	stdin: string | Buffer,
	options: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<CliOutput> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], {
			env: options.env,
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({
				code,
				stdout: Buffer.concat(outChunks).toString("utf8"),
				stderr: Buffer.concat(errChunks).toString("utf8"),
			});
		});
		child.stdin.on("error", () => {
			// Ignore EPIPE when CLI exits early on invalid args or oversized stdin.
		});
		child.stdin.end(stdin);
	});
}

function makeUsage(): Usage {
	return {
		input: 80,
		output: 30,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 110,
		cost: {
			input: 0.001,
			output: 0.001,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.002,
		},
	};
}

function makeModel(): Model<Api> {
	return {
		id: "bg-model",
		name: "BG Model",
		api: "openai-responses",
		provider: "bg-provider",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "bg-provider",
		model: "bg-model",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

interface ExtensionHarness {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, EventHandler[]>;
	appendedEntries: Array<{ customType: string; data: unknown }>;
	emit: (eventName: string, event: unknown, ctx: unknown) => Promise<unknown>;
	getTool: () => ToolDefinition;
	getCommand: () => RegisteredCommand;
}

function createExtensionHarness(
	settings: Record<string, unknown> = {
		defaultProvider: "bg-provider",
		defaultModel: "bg-model",
	},
): ExtensionHarness {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, EventHandler[]>();
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];

	const pi = {
		on(eventName: string, handler: EventHandler): () => void {
			const list = handlers.get(eventName) ?? [];
			list.push(handler);
			handlers.set(eventName, list);
			return () => {};
		},
		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, cmd: RegisteredCommand): void {
			commands.set(name, cmd);
		},
		getSettings: () => settings,
		appendEntry(customType: string, data?: unknown): void {
			appendedEntries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	progressExtension(pi);

	return {
		tools,
		commands,
		handlers,
		appendedEntries,
		async emit(
			eventName: string,
			event: unknown,
			ctx: unknown,
		): Promise<unknown> {
			const list = handlers.get(eventName) ?? [];
			let lastResult: unknown;
			for (const handler of list) {
				lastResult = await handler(event, ctx);
			}
			return lastResult;
		},
		getTool(): ToolDefinition {
			const tool = tools.get("progress");
			assert.ok(tool, "progress tool should be registered");
			return tool;
		},
		getCommand(): RegisteredCommand {
			const cmd = commands.get("progress");
			assert.ok(cmd, "/progress command should be registered");
			return cmd;
		},
	};
}

interface MockContextBundle {
	ctx: ExtensionContext;
	cmdCtx: ExtensionCommandContext;
	toolCtx: ExtensionToolContext;
	notifications: Array<{ message: string; type: string | undefined }>;
	streamSignals: Array<AbortSignal | undefined>;
	setStreamHandler: (
		fn: (signal: AbortSignal | undefined) => Promise<AssistantMessage>,
	) => void;
}

function createMockContext(cwd: string): MockContextBundle {
	const model = makeModel();
	const notifications: Array<{ message: string; type: string | undefined }> =
		[];
	const streamSignals: Array<AbortSignal | undefined> = [];
	let streamHandler: (
		signal: AbortSignal | undefined,
	) => Promise<AssistantMessage> = () =>
		Promise.resolve(makeAssistantMessage('{"tasks":[]}'));

	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: "Please set up CI workflow.",
				timestamp: Date.now(),
			},
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: new Date().toISOString(),
			message: makeAssistantMessage("Added CI workflow and ran checks."),
		},
	];

	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, type?: string): void {
				notifications.push({ message, type });
			},
		},
		sessionManager: {
			getSessionId: (): string => "ext-session-1",
			buildSessionProjection: () => ({
				entries: entries.map((sourceEntry) => ({
					sourceEntry,
					messages: sourceEntry.type === "message" ? [sourceEntry.message] : [],
				})),
			}),
		},
		modelRegistry: {
			find: (provider: string, id: string): Model<Api> | undefined =>
				provider === model.provider && id === model.id ? model : undefined,
			streamSimple: (
				_model: Model<Api>,
				_context: Context,
				options: { signal?: AbortSignal } = {},
			) => {
				streamSignals.push(options.signal);
				return { result: () => streamHandler(options.signal) };
			},
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		cmdCtx: ctx as unknown as ExtensionCommandContext,
		toolCtx: ctx as unknown as ExtensionToolContext,
		notifications,
		streamSignals,
		setStreamHandler: (fn) => {
			streamHandler = fn;
		},
	};
}

describe("progress/cli and progress/index", () => {
	let rootTmp = "";
	let homeDir = "";
	let projectDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		rootTmp = await realpath(
			await mkdtemp(join(tmpdir(), "pi-progress-ext-")),
		);
		homeDir = join(rootTmp, "home");
		projectDir = join(rootTmp, "work", "cli-project");
		await mkdir(homeDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		process.env.HOME = homeDir;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await rm(rootTmp, { recursive: true, force: true });
	});

	describe("real CLI subprocess (progress/cli.ts)", () => {
		test("--help prints usage and exits 0 without creating directories", async () => {
			const res = await runCli(["--help"], "", {
				env: { ...process.env, HOME: homeDir },
			});
			assert.equal(res.code, 0);
			assert.match(res.stdout, /Usage: node cli\.ts \[--cwd DIRECTORY\]/);
			assert.equal(res.stderr, "");
			assert.equal(existsSync(join(homeDir, ".config")), false);
		});

		test("happy path: read (untracked), start, add_task, update_task, add_step, update_step via --cwd and default cwd", async () => {
			const env = { ...process.env, HOME: homeDir };

			// read untracked
			const read0 = await runCli(
				["--cwd", projectDir],
				JSON.stringify({ action: "read" }),
				{ env },
			);
			assert.equal(read0.code, 0);
			const parsed0 = JSON.parse(read0.stdout) as ProgressResult;
			assert.equal(parsed0.document, null);
			assert.equal(existsSync(join(homeDir, ".config")), false);

			// start using default cwd (no --cwd flag)
			const started = await runCli([], JSON.stringify({ action: "start" }), {
				env,
				cwd: projectDir,
			});
			assert.equal(started.code, 0);
			const parsedStart = JSON.parse(started.stdout) as ProgressResult;
			assert.equal(parsedStart.document?.revision, 0);
			assert.equal(parsedStart.document?.project, projectDir);

			// add_task
			const added = await runCli(
				["--cwd", projectDir],
				JSON.stringify({
					action: "add_task",
					expected_revision: 0,
					title: "Migrate DB",
					description: "Zero-downtime expand/contract",
					steps: ["Add column", "Backfill rows"],
				}),
				{ env },
			);
			assert.equal(added.code, 0);
			const parsedAdd = JSON.parse(added.stdout) as ProgressResult;
			assert.equal(parsedAdd.document?.revision, 1);
			const task = parsedAdd.document?.tasks[0];
			const step1 = task?.steps[0];
			assert.ok(task && step1);

			// update_task
			const updTask = await runCli(
				["--cwd", projectDir],
				JSON.stringify({
					action: "update_task",
					expected_revision: 1,
					task_id: task.id,
					title: "Migrate user DB",
				}),
				{ env },
			);
			assert.equal(updTask.code, 0);
			assert.equal(
				(JSON.parse(updTask.stdout) as ProgressResult).document?.revision,
				2,
			);

			// add_step
			const addStep = await runCli(
				["--cwd", projectDir],
				JSON.stringify({
					action: "add_step",
					expected_revision: 2,
					task_id: task.id,
					description: "Drop old column",
				}),
				{ env },
			);
			assert.equal(addStep.code, 0);
			assert.equal(
				(JSON.parse(addStep.stdout) as ProgressResult).document?.tasks[0]?.steps
					.length,
				3,
			);

			// update_step -> completed
			const updStep = await runCli(
				["--cwd", projectDir],
				JSON.stringify({
					action: "update_step",
					expected_revision: 3,
					task_id: task.id,
					step_id: step1.id,
					status: "completed",
					blocked_by: null,
				}),
				{ env },
			);
			assert.equal(updStep.code, 0);
			const parsedStep = JSON.parse(updStep.stdout) as ProgressResult;
			assert.equal(parsedStep.document?.revision, 4);
			assert.equal(
				parsedStep.document?.tasks[0]?.steps[0]?.status,
				"completed",
			);
		});

		test("rejects invalid CLI args, invalid/empty/non-UTF-8/oversized stdin, unknown actions, untracked mutations, and conflicts with exit code 1", async () => {
			const env = { ...process.env, HOME: homeDir };

			const assertCliError = async (
				args: readonly string[],
				stdin: string | Buffer,
				expectedCode: string,
			): Promise<void> => {
				const res = await runCli(args, stdin, { env, cwd: projectDir });
				assert.equal(res.code, 1, `Expected exit 1 for ${expectedCode}`);
				assert.equal(res.stdout, "");
				const parsed = JSON.parse(res.stderr) as {
					code: string;
					message: string;
				};
				assert.equal(parsed.code, expectedCode);
				assert.ok(parsed.message.length > 0);
			};

			// Missing --cwd value, unknown flag, extra arg
			await assertCliError(["--cwd"], '{"action":"read"}', "INVALID_REQUEST");
			await assertCliError(
				["--unknown", projectDir],
				'{"action":"read"}',
				"INVALID_REQUEST",
			);
			await assertCliError(
				["--cwd", projectDir, "extra"],
				'{"action":"read"}',
				"INVALID_REQUEST",
			);

			// Invalid JSON, empty stdin, invalid UTF-8, oversized stdin (> MAX_BYTES)
			await assertCliError(["--cwd", projectDir], "{broken", "INVALID_REQUEST");
			await assertCliError(["--cwd", projectDir], "", "INVALID_REQUEST");
			await assertCliError(
				["--cwd", projectDir],
				Buffer.from([0xff, 0xfe, 0x00]),
				"INVALID_REQUEST",
			);
			await assertCliError(
				["--cwd", projectDir],
				Buffer.alloc(MAX_BYTES + 32, 0x20),
				"INVALID_REQUEST",
			);

			// Unknown action
			await assertCliError(
				["--cwd", projectDir],
				JSON.stringify({ action: "delete_task" }),
				"INVALID_REQUEST",
			);

			// Untracked mutation
			await assertCliError(
				["--cwd", projectDir],
				JSON.stringify({
					action: "add_task",
					expected_revision: 0,
					title: "T",
					description: "D",
					steps: ["S"],
				}),
				"NOT_STARTED",
			);

			// Conflict on stale revision
			await runProgress(projectDir, { action: "start" });
			await assertCliError(
				["--cwd", projectDir],
				JSON.stringify({
					action: "add_task",
					expected_revision: 5,
					title: "T",
					description: "D",
					steps: ["S"],
				}),
				"CONFLICT",
			);
		});
	});

	describe("progress/index.ts tool registration and execution", () => {
		test("registers progress tool, executes read/mutations, blocks start, formats errors, and truncates >50 KiB output", async () => {
			const ext = createExtensionHarness();
			const mock = createMockContext(projectDir);
			const tool = ext.getTool();

			assert.equal(tool.name, "progress");
			assert.equal(tool.executionMode, "sequential");
			assert.ok(tool.outputSchema);

			// Untracked read succeeds cleanly
			const readUntracked = (await tool.execute(
				"call-1",
				{ action: "read" },
				undefined,
				undefined,
				mock.toolCtx,
			)) as AgentToolResult<ProgressResult>;
			assert.equal(readUntracked.details.document, null);
			assert.deepEqual(readUntracked.structuredContent, readUntracked.details);
			assert.equal(existsSync(join(homeDir, ".config")), false);

			// Model-facing tool cannot enable tracking with "start"
			await assert.rejects(
				tool.execute(
					"call-2",
					{ action: "start" } as unknown as Record<string, unknown>,
					undefined,
					undefined,
					mock.toolCtx,
				),
				/INVALID_REQUEST: Use \/progress start to enable tracking\./,
			);

			// Untracked mutation throws formatted NOT_STARTED error
			await assert.rejects(
				tool.execute(
					"call-3",
					{
						action: "add_task",
						expected_revision: 0,
						title: "T",
						description: "D",
						steps: ["S"],
					},
					undefined,
					undefined,
					mock.toolCtx,
				),
				/NOT_STARTED:/,
			);

			// Enable tracking via store, then run full tool mutations
			await runProgress(projectDir, { action: "start" });
			const added = (await tool.execute(
				"call-4",
				{
					action: "add_task",
					expected_revision: 0,
					title: "Tool task",
					description: "Created through extension tool",
					steps: ["Step 1"],
				},
				undefined,
				undefined,
				mock.toolCtx,
			)) as AgentToolResult<ProgressResult>;
			assert.equal(added.details.document?.revision, 1);
			const task = added.details.document?.tasks[0];
			const step = task?.steps[0];
			assert.ok(task && step);

			const updated = (await tool.execute(
				"call-5",
				{
					action: "update_step",
					expected_revision: 1,
					task_id: task.id,
					step_id: step.id,
					status: "completed",
					blocked_by: null,
				},
				undefined,
				undefined,
				mock.toolCtx,
			)) as AgentToolResult<ProgressResult>;
			assert.equal(updated.details.document?.revision, 2);
			assert.equal(
				updated.details.document?.tasks[0]?.steps[0]?.status,
				"completed",
			);

			// Stale revision throws formatted CONFLICT error
			await assert.rejects(
				tool.execute(
					"call-6",
					{
						action: "add_step",
						expected_revision: 0,
						task_id: task.id,
						description: "Stale",
					},
					undefined,
					undefined,
					mock.toolCtx,
				),
				/CONFLICT:/,
			);

			// Output truncation (>50 KiB single-line JSON) adds notice with path while preserving full details/structuredContent
			const huge = (await tool.execute(
				"call-7",
				{
					action: "add_task",
					expected_revision: 2,
					title: "Large payload task",
					description: "d".repeat(55000),
					steps: ["Step huge"],
				},
				undefined,
				undefined,
				mock.toolCtx,
			)) as AgentToolResult<ProgressResult>;
			const textBlock = huge.content[0];
			assert.equal(textBlock?.type, "text");
			const text = textBlock?.type === "text" ? textBlock.text : "";
			assert.match(text, /\[Truncated\. Read the complete JSON at /);
			assert.ok(text.includes(JSON.stringify(huge.details.path)));
			assert.equal(huge.details.document?.tasks.length, 2);
			assert.deepEqual(huge.structuredContent, huge.details);
		});
	});

	describe("progress/index.ts /progress command", () => {
		test("handles status read, start (idempotent), invalid subcommands, and store errors", async () => {
			const ext = createExtensionHarness();
			const mock = createMockContext(projectDir);
			const cmd = ext.getCommand();

			// Untracked status check
			await cmd.handler("   ", mock.cmdCtx);
			assert.equal(mock.notifications.length, 1);
			assert.equal(mock.notifications[0]?.type, "info");
			assert.match(mock.notifications[0]?.message ?? "", /Tracking is off\./);
			assert.equal(existsSync(join(homeDir, ".config")), false);

			// Start tracking
			await cmd.handler("start", mock.cmdCtx);
			assert.equal(mock.notifications.length, 2);
			assert.equal(mock.notifications[1]?.type, "info");
			assert.match(
				mock.notifications[1]?.message ?? "",
				/0 tasks; 0\/0 steps completed; 0 blocked; revision 0\./,
			);

			// Add task with 1 completed and 1 blocked step, check /progress summary
			const added = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "Release",
				description: "Prep v1",
				steps: ["Run tests", "Sign artifact"],
			});
			const t = added.document?.tasks[0];
			const s1 = t?.steps[0];
			const s2 = t?.steps[1];
			assert.ok(t && s1 && s2);
			await runProgress(projectDir, {
				action: "update_step",
				expected_revision: 1,
				task_id: t.id,
				step_id: s1.id,
				status: "completed",
				blocked_by: null,
			});
			await runProgress(projectDir, {
				action: "update_step",
				expected_revision: 2,
				task_id: t.id,
				step_id: s2.id,
				status: "blocked",
				blocked_by: "Waiting for signing key",
			});

			await cmd.handler("", mock.cmdCtx);
			assert.equal(mock.notifications[2]?.type, "info");
			assert.match(
				mock.notifications[2]?.message ?? "",
				/1 tasks; 1\/2 steps completed; 1 blocked; revision 3\./,
			);

			// Repeated /progress start preserves existing tasks
			await cmd.handler(" start ", mock.cmdCtx);
			assert.equal(mock.notifications[3]?.type, "info");
			assert.match(mock.notifications[3]?.message ?? "", /revision 3\./);

			// Invalid subcommands (on, off, status, extra args)
			for (const badArg of ["on", "off", "status", "start extra"]) {
				const before: number = mock.notifications.length;
				await cmd.handler(badArg, mock.cmdCtx);
				assert.equal(mock.notifications.length, before + 1);
				assert.equal(mock.notifications[before]?.type, "error");
				assert.match(
					mock.notifications[before]?.message ?? "",
					/INVALID_REQUEST: Usage: \/progress \[start\]/,
				);
			}

			// Corrupt file error surfaced via error notification
			const filePath = await progressPath(projectDir);
			await writeFile(filePath, "{corrupt");
			const beforeErr: number = mock.notifications.length;
			await cmd.handler("", mock.cmdCtx);
			assert.equal(mock.notifications[beforeErr]?.type, "error");
			assert.match(
				mock.notifications[beforeErr]?.message ?? "",
				/INVALID_DOCUMENT:/,
			);
		});
	});

	describe("progress/index.ts before_agent_start and lifecycle hooks", () => {
		test("before_agent_start returns undefined when untracked, injects hidden context when tracked, invalidates in-flight update, and warns on corrupt file", async () => {
			const ext = createExtensionHarness();
			const mock = createMockContext(projectDir);
			const startEvent = { type: "before_agent_start" } as BeforeAgentStartEvent;

			// Untracked -> undefined and no directories created
			const untracked = (await ext.emit(
				"before_agent_start",
				startEvent,
				mock.ctx,
			)) as BeforeAgentStartEventResult | undefined;
			assert.equal(untracked, undefined);
			assert.equal(existsSync(join(homeDir, ".config")), false);

			// Tracked -> injects hidden progress-context message & invalidates in-flight background update
			await runProgress(projectDir, { action: "start" });
			await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "Docs",
				description: "Write API docs",
				steps: ["Draft README"],
			});
			let resolveBg!: (msg: AssistantMessage) => void;
			mock.setStreamHandler(
				() =>
					new Promise<AssistantMessage>((resolve) => {
						resolveBg = resolve;
					}),
			);
			await ext.emit(
				"agent_settled",
				{ type: "agent_settled", aborted: false } as AgentSettledEvent,
				mock.ctx,
			);
			while (mock.streamSignals.length < 1) {
				await new Promise((r) => setTimeout(r, 5));
			}
			assert.equal(mock.streamSignals[0]?.aborted, false);

			const tracked = (await ext.emit(
				"before_agent_start",
				startEvent,
				mock.ctx,
			)) as BeforeAgentStartEventResult | undefined;
			assert.equal(mock.streamSignals[0]?.aborted, true);
			resolveBg(makeAssistantMessage('{"tasks":[]}'));
			assert.ok(tracked?.message);
			assert.equal(tracked.message.customType, "progress-context");
			assert.equal(tracked.message.display, false);
			assert.match(
				String(tracked.message.content),
				/Task tracking is enabled at .*1 tasks; 0\/1 steps completed; 0 blocked; revision 1\./,
			);

			// Corrupt file -> injects tracking-unavailable message
			const filePath = await progressPath(projectDir);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, "not-valid-json");
			const errored = (await ext.emit(
				"before_agent_start",
				startEvent,
				mock.ctx,
			)) as BeforeAgentStartEventResult | undefined;
			assert.ok(errored?.message);
			assert.equal(errored.message.customType, "progress-context");
			assert.equal(errored.message.display, false);
			assert.match(
				String(errored.message.content),
				/Progress tracking is unavailable: INVALID_DOCUMENT:/,
			);
		});

		test("agent_settled schedules background update, aborted settled skips, quit shutdown drains, and input/tree/reload cancel", async () => {
			await runProgress(projectDir, { action: "start" });
			const ext = createExtensionHarness();
			const mock = createMockContext(projectDir);

			// 1. agent_settled with aborted: true does NOT schedule
			await ext.emit(
				"agent_settled",
				{ type: "agent_settled", aborted: true } as AgentSettledEvent,
				mock.ctx,
			);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(mock.streamSignals.length, 0);

			// 2. input invalidates an in-flight update
			let resolveFirst!: (msg: AssistantMessage) => void;
			mock.setStreamHandler(
				() =>
					new Promise<AssistantMessage>((resolve) => {
						resolveFirst = resolve;
					}),
			);
			await ext.emit(
				"agent_settled",
				{ type: "agent_settled", aborted: false } as AgentSettledEvent,
				mock.ctx,
			);
			while (mock.streamSignals.length < 1) {
				await new Promise((r) => setTimeout(r, 5));
			}
			const firstSignal = mock.streamSignals[0];
			assert.equal(firstSignal?.aborted, false);
			const inputResult = await ext.emit("input", { type: "input" }, mock.ctx);
			assert.equal(inputResult, undefined);
			assert.equal(firstSignal?.aborted, true);
			resolveFirst(makeAssistantMessage('{"tasks":[]}'));

			// 3. session_tree also invalidates an in-flight update
			let resolveSecond!: (msg: AssistantMessage) => void;
			mock.setStreamHandler(
				() =>
					new Promise<AssistantMessage>((resolve) => {
						resolveSecond = resolve;
					}),
			);
			await ext.emit(
				"agent_settled",
				{ type: "agent_settled", aborted: false } as AgentSettledEvent,
				mock.ctx,
			);
			while (mock.streamSignals.length < 2) {
				await new Promise((r) => setTimeout(r, 5));
			}
			await ext.emit("session_tree", { type: "session_tree" }, mock.ctx);
			assert.equal(mock.streamSignals[1]?.aborted, true);
			resolveSecond(makeAssistantMessage('{"tasks":[]}'));

			// 4. session_shutdown with reason: "reload" aborts immediately without waiting; session_start re-enables
			mock.setStreamHandler(() => new Promise<AssistantMessage>(() => {}));
			await ext.emit(
				"agent_settled",
				{ type: "agent_settled", aborted: false } as AgentSettledEvent,
				mock.ctx,
			);
			while (mock.streamSignals.length < 3) {
				await new Promise((r) => setTimeout(r, 5));
			}
			await ext.emit(
				"session_shutdown",
				{ type: "session_shutdown", reason: "reload" } as SessionShutdownEvent,
				mock.ctx,
			);
			assert.equal(mock.streamSignals[2]?.aborted, true);

			// While stopped after reload shutdown, agent_settled is ignored until session_start
			await ext.emit(
				"agent_settled",
				{ type: "agent_settled", aborted: false } as AgentSettledEvent,
				mock.ctx,
			);
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(mock.streamSignals.length, 3);

			// 5. session_start re-enables, agent_settled runs, and session_shutdown(reason: "quit") drains to completion
			await ext.emit("session_start", { type: "session_start" }, mock.ctx);
			let resolveQuit!: (msg: AssistantMessage) => void;
			mock.setStreamHandler(
				() =>
					new Promise<AssistantMessage>((resolve) => {
						resolveQuit = resolve;
					}),
			);
			await ext.emit(
				"agent_settled",
				{ type: "agent_settled", aborted: false } as AgentSettledEvent,
				mock.ctx,
			);
			while (mock.streamSignals.length < 4) {
				await new Promise((r) => setTimeout(r, 5));
			}

			const origErr = console.error;
			console.error = (): void => {};
			try {
				const shutdownPromise = ext.emit(
					"session_shutdown",
					{ type: "session_shutdown", reason: "quit" } as SessionShutdownEvent,
					mock.ctx,
				);
				resolveQuit(
					makeAssistantMessage(
						JSON.stringify({
							tasks: [
								{
									id: null,
									title: "CI workflow",
									description: "Added CI workflow",
									steps: [
										{
											id: null,
											description: "Verify CI checks",
											status: "completed",
											blocked_by: null,
										},
									],
								},
							],
						}),
					),
				);
				await shutdownPromise;
			} finally {
				console.error = origErr;
			}

			const finalState = await runProgress(projectDir, { action: "read" });
			assert.equal(finalState.document?.revision, 1);
			assert.equal(finalState.document?.tasks[0]?.title, "CI workflow");
			assert.equal(ext.appendedEntries.length, 1);
			assert.equal(ext.appendedEntries[0]?.customType, "progress-usage");
		});
	});
});
