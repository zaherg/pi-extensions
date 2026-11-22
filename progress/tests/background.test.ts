import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StopReason,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	createProgressUpdater,
	projectConversation,
	selectProgressModel,
} from "../background.ts";
import { ProgressError, runProgress } from "../store.ts";

interface RecordedNotification {
	message: string;
	type: string | undefined;
}

interface RecordedUsageEntry {
	customType: string;
	data: unknown;
}

interface StreamCall {
	model: Model<Api>;
	context: Context;
	options: { signal?: AbortSignal; maxTokens?: number; maxRetries?: number };
}

type StreamHandler = (
	call: StreamCall,
) => Promise<AssistantMessage> | { result: () => Promise<AssistantMessage> };

function makeUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 120,
		output: 45,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 165,
		cost: {
			input: 0.001,
			output: 0.002,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.003,
		},
		...overrides,
	};
}

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

function makeAssistantMessage(
	text: string,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function makeUserEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			content,
			timestamp: Date.now(),
		},
	};
}

function makeAssistantEntry(
	id: string,
	text: string,
	stopReason: StopReason = "stop",
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: makeAssistantMessage(text, { stopReason }),
	};
}

function createSerialQueue(): <T>(
	path: string,
	operation: () => Promise<T>,
) => Promise<T> {
	const tails = new Map<string, Promise<void>>();
	return async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
		const prev = tails.get(path) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chained = prev.then(() => next);
		tails.set(path, chained);
		await prev;
		try {
			return await operation();
		} finally {
			release();
			if (tails.get(path) === chained) tails.delete(path);
		}
	};
}

interface TestHarness {
	host: Pick<ExtensionAPI, "getSettings" | "appendEntry">;
	ctx: ExtensionContext;
	notifications: RecordedNotification[];
	appendedEntries: RecordedUsageEntry[];
	streamCalls: StreamCall[];
	setEntries: (next: SessionEntry[]) => void;
	setSessionId: (id: string) => void;
	setSettings: (next: Record<string, unknown>) => void;
	setStreamHandler: (handler: StreamHandler) => void;
	setModelLookup: (
		fn: (provider: string, id: string) => Model<Api> | undefined,
	) => void;
}

function createHarness(options: {
	cwd: string;
	entries?: SessionEntry[];
	model?: Model<Api>;
	settings?: Record<string, unknown>;
	hasUI?: boolean;
	streamHandler?: StreamHandler;
}): TestHarness {
	const notifications: RecordedNotification[] = [];
	const appendedEntries: RecordedUsageEntry[] = [];
	const streamCalls: StreamCall[] = [];
	const defaultModel = options.model ?? makeModel();
	let entries: SessionEntry[] = options.entries ?? [
		makeUserEntry("u1", "Please implement search using the local index."),
		makeAssistantEntry(
			"a1",
			"Implemented local search and verified tests pass.",
		),
	];
	let sessionId = "session-1";
	let settings: Record<string, unknown> = options.settings ?? {
		defaultProvider: defaultModel.provider,
		defaultModel: defaultModel.id,
	};
	let modelLookup: (provider: string, id: string) => Model<Api> | undefined = (
		provider,
		id,
	) =>
		provider === defaultModel.provider && id === defaultModel.id
			? defaultModel
			: undefined;
	let streamHandler: StreamHandler =
		options.streamHandler ??
		(() => Promise.resolve(makeAssistantMessage('{"tasks":[]}')));

	const host = {
		getSettings: () => settings as ReturnType<ExtensionAPI["getSettings"]>,
		appendEntry: (customType: string, data?: unknown): void => {
			appendedEntries.push({ customType, data });
		},
	} as Pick<ExtensionAPI, "getSettings" | "appendEntry">;

	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, type?: string): void => {
				notifications.push({ message, type });
			},
		},
		sessionManager: {
			getSessionId: (): string => sessionId,
			buildSessionProjection: () => ({
				entries: entries.map((sourceEntry) => ({
					sourceEntry,
					messages: sourceEntry.type === "message" ? [sourceEntry.message] : [],
				})),
			}),
		},
		modelRegistry: {
			find: (provider: string, id: string): Model<Api> | undefined =>
				modelLookup(provider, id),
			streamSimple: (
				model: Model<Api>,
				context: Context,
				streamOptions: {
					signal?: AbortSignal;
					maxTokens?: number;
					maxRetries?: number;
				} = {},
			) => {
				const call: StreamCall = { model, context, options: streamOptions };
				streamCalls.push(call);
				const out = streamHandler(call);
				if (out instanceof Promise) {
					return { result: () => out };
				}
				return out;
			},
		},
	} as unknown as ExtensionContext;

	return {
		host,
		ctx,
		notifications,
		appendedEntries,
		streamCalls,
		setEntries: (next) => {
			entries = next;
		},
		setSessionId: (id) => {
			sessionId = id;
		},
		setSettings: (next) => {
			settings = next;
		},
		setStreamHandler: (handler) => {
			streamHandler = handler;
		},
		setModelLookup: (fn) => {
			modelLookup = fn;
		},
	};
}

function captureConsoleError(): {
	messages: string[];
	restore: () => void;
} {
	const messages: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]): void => {
		messages.push(args.map(String).join(" "));
	};
	return {
		messages,
		restore: () => {
			console.error = original;
		},
	};
}

describe("progress/background", () => {
	let rootTmp = "";
	let homeDir = "";
	let projectDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		rootTmp = await realpath(await mkdtemp(join(tmpdir(), "pi-progress-bg-")));
		homeDir = join(rootTmp, "home");
		projectDir = join(rootTmp, "work", "bg-project");
		await mkdir(homeDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		process.env.HOME = homeDir;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await rm(rootTmp, { recursive: true, force: true });
	});

	describe("selectProgressModel", () => {
		test("resolves defaultProvider/defaultModel and supports progress.model with nested slashes", () => {
			const defaultModel = makeModel({
				provider: "anthropic",
				id: "claude-sonnet",
			});
			const nestedModel = makeModel({
				provider: "openrouter",
				id: "deepseek/deepseek-v4.1-flash",
			});
			const registry = {
				find: (provider: string, id: string): Model<Api> | undefined => {
					if (provider === defaultModel.provider && id === defaultModel.id)
						return defaultModel;
					if (provider === nestedModel.provider && id === nestedModel.id)
						return nestedModel;
					return undefined;
				},
			};

			assert.equal(
				selectProgressModel(
					{
						defaultProvider: "anthropic",
						defaultModel: "claude-sonnet",
					} as ReturnType<ExtensionAPI["getSettings"]>,
					registry,
				),
				defaultModel,
			);

			assert.equal(
				selectProgressModel(
					{
						defaultProvider: "anthropic",
						defaultModel: "claude-sonnet",
						progress: {},
					} as ReturnType<ExtensionAPI["getSettings"]> & { progress?: unknown },
					registry,
				),
				defaultModel,
			);

			assert.equal(
				selectProgressModel(
					{
						defaultProvider: "anthropic",
						defaultModel: "claude-sonnet",
						progress: { model: "openrouter/deepseek/deepseek-v4.1-flash" },
					} as ReturnType<ExtensionAPI["getSettings"]> & { progress?: unknown },
					registry,
				),
				nestedModel,
			);
		});

		test("throws MODEL_CONFIG on malformed settings and MODEL_UNAVAILABLE when unregistered", () => {
			const registry = {
				find: (): Model<Api> | undefined => undefined,
			};
			const invalidConfigs: unknown[] = [
				null,
				{},
				{ defaultProvider: "only-provider" },
				{ defaultModel: "only-model" },
				{ defaultProvider: "bad/provider", defaultModel: "m" },
				{ defaultProvider: "p", defaultModel: "bad model" },
				{ defaultProvider: "p", defaultModel: "m", progress: "bad" },
				{ defaultProvider: "p", defaultModel: "m", progress: { unknown: 1 } },
				{ defaultProvider: "p", defaultModel: "m", progress: { model: "" } },
				{
					defaultProvider: "p",
					defaultModel: "m",
					progress: { model: "no-slash" },
				},
				{
					defaultProvider: "p",
					defaultModel: "m",
					progress: { model: "/missing-provider" },
				},
				{
					defaultProvider: "p",
					defaultModel: "m",
					progress: { model: "provider/has space" },
				},
			];
			for (const cfg of invalidConfigs) {
				assert.throws(
					() =>
						selectProgressModel(
							cfg as ReturnType<ExtensionAPI["getSettings"]> & {
								progress?: unknown;
							},
							registry,
						),
					(err: unknown) =>
						err instanceof ProgressError && err.code === "MODEL_CONFIG",
				);
			}

			assert.throws(
				() =>
					selectProgressModel(
						{
							defaultProvider: "openai",
							defaultModel: "gpt-missing",
						} as ReturnType<ExtensionAPI["getSettings"]>,
						registry,
					),
				(err: unknown) =>
					err instanceof ProgressError && err.code === "MODEL_UNAVAILABLE",
			);
		});
	});

	describe("projectConversation", () => {
		test("filters entries, extracts text parts, redacts secrets, and sets completed flag", () => {
			const entries: SessionEntry[] = [
				{
					type: "custom",
					id: "c1",
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: "progress-usage",
					data: { ignored: true },
				},
				makeUserEntry(
					"u1",
					"Use Authorization: \x1b[32mBearer\x1b[0m supersecrettoken123 and api_key\u200b=my_secret_val_99 with https://alice:pass123@example.com/repo",
				),
				{
					type: "message",
					id: "t1",
					parentId: "u1",
					timestamp: new Date().toISOString(),
					message: {
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "bash",
						content: [{ type: "text", text: "tool output ignored" }],
						isError: false,
						timestamp: Date.now(),
					},
				},
				makeAssistantEntry("a-tool", "Intermediate tool call", "toolUse"),
				{
					type: "message",
					id: "a-final",
					parentId: "t1",
					timestamp: new Date().toISOString(),
					message: {
						...makeAssistantMessage("", { stopReason: "stop" }),
						content: [
							{ type: "thinking", thinking: "hidden reasoning" },
							{
								type: "text",
								text: "Configured sk-1234567890abcdef1234 and ghp_1234567890abcdefghij",
							},
						],
					},
				},
			];

			const projected = projectConversation(entries);
			assert.equal(projected.completed, true);
			assert.equal(projected.truncated, false);
			assert.equal(projected.messages.length, 2);
			assert.equal(projected.messages[0]?.role, "user");
			assert.equal(
				projected.messages[0]?.text.includes("supersecrettoken123"),
				false,
			);
			assert.equal(
				projected.messages[0]?.text.includes("my_secret_val_99"),
				false,
			);
			assert.equal(
				projected.messages[0]?.text.includes("alice:pass123"),
				false,
			);
			assert.match(projected.messages[0]?.text ?? "", /Bearer \[REDACTED\]/);
			assert.equal(projected.messages[1]?.role, "assistant");
			assert.equal(
				projected.messages[1]?.text.includes("hidden reasoning"),
				false,
			);
			assert.equal(
				projected.messages[1]?.text.includes("sk-1234567890abcdef1234"),
				false,
			);
			assert.equal(
				projected.messages[1]?.text.includes("ghp_1234567890abcdefghij"),
				false,
			);

			// Latest message is user -> completed is false
			const unfinished = projectConversation([
				...entries,
				makeUserEntry("u2", "One more thing"),
			]);
			assert.equal(unfinished.completed, false);
		});

		test("enforces 24-message, 6000-char per message, 16000-char total truncation limits, and avoids lone UTF-16 surrogates", () => {
			// > 24 messages
			const many = Array.from({ length: 30 }, (_, i) =>
				i % 2 === 0
					? makeUserEntry(`m${i}`, `User turn ${i}`)
					: makeAssistantEntry(`m${i}`, `Assistant turn ${i}`),
			);
			const resMany = projectConversation(many);
			assert.equal(resMany.messages.length, 24);
			assert.equal(resMany.truncated, true);
			assert.equal(resMany.messages[0]?.id, "m6");
			assert.equal(resMany.messages.at(-1)?.id, "m29");

			// Per-message 6000-char cap and 16000-char total cap
			const longEntries: SessionEntry[] = [
				makeUserEntry("l1", "a".repeat(7000)),
				makeAssistantEntry("l2", "b".repeat(7000)),
				makeUserEntry("l3", "c".repeat(7000)),
				makeAssistantEntry("l4", "d".repeat(7000)),
			];
			const resLong = projectConversation(longEntries);
			assert.equal(resLong.truncated, true);
			const totalChars = resLong.messages.reduce(
				(sum, m) => sum + m.text.length,
				0,
			);
			assert.equal(totalChars, 16000);
			for (const msg of resLong.messages) {
				assert.ok(msg.text.length <= 6000);
			}

			// Surrogate pair straddling index 5999..6000 must not emit a lone surrogate
			const astralBoundary = `${"x".repeat(5999)}🚀tail`;
			const astralRes = projectConversation([
				makeUserEntry("u-emoji", astralBoundary),
				makeAssistantEntry("a-emoji", "ok"),
			]);
			const slicedUser = astralRes.messages[0]?.text ?? "";
			assert.equal(slicedUser.length, 5999);
			assert.equal(slicedUser.isWellFormed(), true);
			assert.equal(slicedUser.includes("\ufffd"), false);
		});
	});

	describe("createProgressUpdater happy paths", () => {
		test("schedules on settled turn, redacts input & output secrets, persists proposal, and appends progress-usage", async () => {
			await runProgress(projectDir, { action: "start" });
			const model = makeModel({ maxTokens: 16384 });
			const usage = makeUsage({ input: 210, output: 85, totalTokens: 295 });
			const harness = createHarness({
				cwd: projectDir,
				model,
				entries: [
					makeUserEntry(
						"u1",
						"Build OAuth login using secret_key=TOPSECRET_INPUT_123",
					),
					makeAssistantEntry("a1", "Implemented OAuth login and tests passed."),
				],
				streamHandler: () =>
					Promise.resolve(
						makeAssistantMessage(
							JSON.stringify({
								tasks: [
									{
										id: null,
										title: "OAuth login",
										description:
											"Configured provider with token=TOPSECRET_OUTPUT_456",
										steps: [
											{
												id: null,
												description:
													"Implement OAuth callback and verify tests",
												status: "completed",
												blocked_by: null,
											},
										],
									},
								],
							}),
							{ usage },
						),
					),
			});

			const updater = createProgressUpdater(harness.host, createSerialQueue());
			updater.schedule(harness.ctx);
			await updater.whenIdle();

			assert.equal(harness.notifications.length, 0);
			assert.equal(harness.streamCalls.length, 1);
			const call = harness.streamCalls[0];
			assert.ok(call);
			assert.equal(call.options.maxTokens, 4096);
			assert.equal(call.options.maxRetries, 0);
			assert.ok(call.context.systemPrompt?.includes("portable task progress"));

			const sentContent = call.context.messages[0]?.content;
			assert.equal(typeof sentContent, "string");
			assert.equal(String(sentContent).includes("TOPSECRET_INPUT_123"), false);
			assert.match(String(sentContent), /\[REDACTED\]/);

			// Verify persisted document (and redacted output secret!)
			const saved = await runProgress(projectDir, { action: "read" });
			assert.equal(saved.document?.revision, 1);
			assert.equal(saved.document?.tasks.length, 1);
			assert.equal(saved.document?.tasks[0]?.title, "OAuth login");
			assert.equal(
				saved.document?.tasks[0]?.description.includes("TOPSECRET_OUTPUT_456"),
				false,
			);
			assert.match(
				saved.document?.tasks[0]?.description ?? "",
				/token=\[REDACTED\]/,
			);
			assert.equal(saved.document?.tasks[0]?.steps[0]?.status, "completed");

			// Verify progress-usage entry appended
			assert.equal(harness.appendedEntries.length, 1);
			assert.equal(harness.appendedEntries[0]?.customType, "progress-usage");
			assert.deepEqual(harness.appendedEntries[0]?.data, {
				provider: model.provider,
				model: model.id,
				usage,
			});
		});

		test("coalesces rapid schedule calls so only the newest snapshot is persisted", async () => {
			await runProgress(projectDir, { action: "start" });
			let callCount = 0;
			let firstSignalAborted = false;
			let releaseFirst!: () => void;
			const firstStarted = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});

			const harness = createHarness({
				cwd: projectDir,
				entries: [
					makeUserEntry("u1", "Turn 1"),
					makeAssistantEntry("a1", "Reply 1"),
				],
				streamHandler: ({ options }) => {
					callCount++;
					if (callCount === 1) {
						releaseFirst();
						return new Promise<AssistantMessage>((_resolve, reject) => {
							options.signal?.addEventListener("abort", () => {
								firstSignalAborted = true;
								reject(options.signal?.reason);
							});
						});
					}
					return Promise.resolve(
						makeAssistantMessage(
							JSON.stringify({
								tasks: [
									{
										id: null,
										title: "Final coalesced task",
										description: "From turn 3",
										steps: [
											{
												id: null,
												description: "Step from turn 3",
												status: "working",
												blocked_by: null,
											},
										],
									},
								],
							}),
						),
					);
				},
			});

			const updater = createProgressUpdater(harness.host, createSerialQueue());
			updater.schedule(harness.ctx);
			await firstStarted;

			// Rapidly schedule turn 2 and turn 3 while turn 1 is in flight
			harness.setEntries([
				makeUserEntry("u1", "Turn 1"),
				makeAssistantEntry("a1", "Reply 1"),
				makeUserEntry("u2", "Turn 2"),
				makeAssistantEntry("a2", "Reply 2"),
			]);
			updater.schedule(harness.ctx);

			harness.setEntries([
				makeUserEntry("u1", "Turn 1"),
				makeAssistantEntry("a1", "Reply 1"),
				makeUserEntry("u2", "Turn 2"),
				makeAssistantEntry("a2", "Reply 2"),
				makeUserEntry("u3", "Turn 3"),
				makeAssistantEntry("a3", "Reply 3"),
			]);
			updater.schedule(harness.ctx);

			await updater.whenIdle();
			assert.equal(firstSignalAborted, true);
			assert.equal(callCount, 2); // turn 1 aborted, turn 2 coalesced away, turn 3 ran
			assert.equal(harness.notifications.length, 0);

			const saved = await runProgress(projectDir, { action: "read" });
			assert.equal(saved.document?.revision, 1);
			assert.equal(saved.document?.tasks[0]?.title, "Final coalesced task");
		});

		test("finishBeforeExit waits for active update, logs waiting notice only for tracked model updates, and stops new schedules", async () => {
			// Untracked project quit during initial read must NOT spam "Waiting for progress update..."
			const untrackedStderr = captureConsoleError();
			try {
				const untracked = createHarness({ cwd: projectDir });
				const untrackedUpdater = createProgressUpdater(
					untracked.host,
					createSerialQueue(),
				);
				untrackedUpdater.schedule(untracked.ctx);
				await untrackedUpdater.finishBeforeExit();
				assert.equal(
					untrackedStderr.messages.some((m) =>
						m.includes("Waiting for progress update"),
					),
					false,
				);
			} finally {
				untrackedStderr.restore();
			}

			await runProgress(projectDir, { action: "start" });
			let resolveStream!: (msg: AssistantMessage) => void;
			const harness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					new Promise<AssistantMessage>((resolve) => {
						resolveStream = resolve;
					}),
			});

			const stderr = captureConsoleError();
			try {
				const updater = createProgressUpdater(
					harness.host,
					createSerialQueue(),
				);
				updater.schedule(harness.ctx);
				// Wait a tick for streamSimple to be invoked
				while (harness.streamCalls.length === 0) {
					await new Promise((r) => setTimeout(r, 5));
				}

				const exitPromise = updater.finishBeforeExit();
				// New schedules during closing are ignored
				harness.setEntries([
					makeUserEntry("u1", "Please implement search using the local index."),
					makeAssistantEntry(
						"a1",
						"Implemented local search and verified tests pass.",
					),
				]);
				updater.schedule(harness.ctx);

				resolveStream(
					makeAssistantMessage(
						JSON.stringify({
							tasks: [
								{
									id: null,
									title: "Drained before exit",
									description: "Persisted cleanly on quit",
									steps: [
										{
											id: null,
											description: "Finish flush",
											status: "completed",
											blocked_by: null,
										},
									],
								},
							],
						}),
					),
				);
				await exitPromise;

				assert.ok(
					stderr.messages.some((m) =>
						m.includes("Waiting for progress update before quitting Pi"),
					),
				);
				const saved = await runProgress(projectDir, { action: "read" });
				assert.equal(saved.document?.revision, 1);
				assert.equal(saved.document?.tasks[0]?.title, "Drained before exit");

				// After finishBeforeExit(), updater is stopped until start() is called
				updater.schedule(harness.ctx);
				await updater.whenIdle();
				assert.equal(harness.streamCalls.length, 1);

				// start() re-enables scheduling
				updater.start();
				harness.setStreamHandler(() =>
					Promise.resolve(makeAssistantMessage('{"tasks":[]}')),
				);
				updater.schedule(harness.ctx);
				await updater.whenIdle();
				assert.equal(harness.streamCalls.length, 2);
			} finally {
				stderr.restore();
			}
		});
	});

	describe("createProgressUpdater edge cases", () => {
		test("stopReason 'aborted' is treated as clean cancellation with no warning, no usage, and no store mutation", async () => {
			await runProgress(projectDir, { action: "start" });
			const harness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					Promise.resolve(
						makeAssistantMessage("", {
							stopReason: "aborted",
							usage: makeUsage({ input: 0, output: 0, totalTokens: 0 }),
						}),
					),
			});

			const updater = createProgressUpdater(harness.host, createSerialQueue());
			updater.schedule(harness.ctx);
			await updater.whenIdle();

			assert.equal(harness.notifications.length, 0);
			assert.equal(harness.appendedEntries.length, 0);
			const saved = await runProgress(projectDir, { action: "read" });
			assert.equal(saved.document?.revision, 0);
		});

		test("stopReason 'error' surfaces MODEL_FAILED without leaking raw errorMessage or parsing empty text as JSON", async () => {
			await runProgress(projectDir, { action: "start" });
			const harness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					Promise.resolve(
						makeAssistantMessage("", {
							stopReason: "error",
							errorMessage: "SECRET_UPSTREAM_PROVIDER_STACKTRACE",
							usage: makeUsage({ input: 0, output: 0, totalTokens: 0 }),
						}),
					),
			});

			const updater = createProgressUpdater(harness.host, createSerialQueue());
			updater.schedule(harness.ctx);
			await updater.whenIdle();

			assert.equal(harness.appendedEntries.length, 0);
			assert.equal(harness.notifications.length, 1);
			assert.equal(harness.notifications[0]?.type, "warning");
			assert.match(harness.notifications[0]?.message ?? "", /MODEL_FAILED/);
			assert.equal(
				harness.notifications[0]?.message.includes("INVALID_PROPOSAL"),
				false,
			);
			assert.equal(
				harness.notifications[0]?.message.includes(
					"SECRET_UPSTREAM_PROVIDER_STACKTRACE",
				),
				false,
			);
		});

		test("abort.signal.throwIfAborted() is prioritized over resolved stream stopReason", async () => {
			await runProgress(projectDir, { action: "start" });

			// Case 1: Timeout aborts signal, stream resolves with stopReason: "aborted" right when signal fires
			const timeoutHarness = createHarness({
				cwd: projectDir,
				streamHandler: ({ options }) => {
					return new Promise<AssistantMessage>((resolve) => {
						options.signal?.addEventListener("abort", () => {
							resolve(
								makeAssistantMessage("", {
									stopReason: "aborted",
								}),
							);
						});
					});
				},
			});
			const timeoutUpdater = createProgressUpdater(
				timeoutHarness.host,
				createSerialQueue(),
				{ timeoutMs: 30 },
			);
			timeoutUpdater.schedule(timeoutHarness.ctx);
			await timeoutUpdater.whenIdle();

			assert.equal(timeoutHarness.notifications.length, 1);
			assert.match(timeoutHarness.notifications[0]?.message ?? "", /TIMEOUT/);

			// Case 2: User invalidation aborts signal, stream resolves with stopReason: "error" -> no warning!
			let resolveInvalidated!: (msg: AssistantMessage) => void;
			const invHarness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					new Promise<AssistantMessage>((resolve) => {
						resolveInvalidated = resolve;
					}),
			});
			const invUpdater = createProgressUpdater(
				invHarness.host,
				createSerialQueue(),
			);
			invUpdater.schedule(invHarness.ctx);
			while (invHarness.streamCalls.length === 0) {
				await new Promise((r) => setTimeout(r, 5));
			}
			invUpdater.invalidate();
			resolveInvalidated(
				makeAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider error after cancel",
				}),
			);
			await invUpdater.whenIdle();

			assert.equal(invHarness.notifications.length, 0);
			assert.equal(invHarness.appendedEntries.length, 0);
		});

		test("zero-token usage suppresses progress-usage on non-stop response, while positive usage records it", async () => {
			await runProgress(projectDir, { action: "start" });

			// Zero tokens + stopReason: "length" -> NO progress-usage entry, MODEL_FAILED warning
			const zeroHarness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					Promise.resolve(
						makeAssistantMessage('{"tasks":', {
							stopReason: "length",
							usage: makeUsage({
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
							}),
						}),
					),
			});
			const zeroUpdater = createProgressUpdater(
				zeroHarness.host,
				createSerialQueue(),
			);
			zeroUpdater.schedule(zeroHarness.ctx);
			await zeroUpdater.whenIdle();

			assert.equal(zeroHarness.appendedEntries.length, 0);
			assert.equal(zeroHarness.notifications.length, 1);
			assert.match(
				zeroHarness.notifications[0]?.message ?? "",
				/MODEL_FAILED.*complete response/i,
			);

			// Non-zero tokens + stopReason: "length" -> records progress-usage AND warns MODEL_FAILED
			const billedUsage = makeUsage({
				input: 100,
				output: 4096,
				totalTokens: 4196,
			});
			const billedHarness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					Promise.resolve(
						makeAssistantMessage('{"tasks":', {
							stopReason: "length",
							usage: billedUsage,
						}),
					),
			});
			const billedUpdater = createProgressUpdater(
				billedHarness.host,
				createSerialQueue(),
			);
			billedUpdater.schedule(billedHarness.ctx);
			await billedUpdater.whenIdle();

			assert.equal(billedHarness.appendedEntries.length, 1);
			assert.deepEqual(billedHarness.appendedEntries[0]?.data, {
				provider: "test-provider",
				model: "test-model",
				usage: billedUsage,
			});
			assert.equal(billedHarness.notifications.length, 1);
			assert.match(
				billedHarness.notifications[0]?.message ?? "",
				/MODEL_FAILED/,
			);
		});

		test("provider rejection and hung provider timeout warn MODEL_FAILED / TIMEOUT without hanging queue", async () => {
			await runProgress(projectDir, { action: "start" });

			const rejectHarness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					Promise.reject(new Error("401 Unauthorized secret")),
			});
			const rejectUpdater = createProgressUpdater(
				rejectHarness.host,
				createSerialQueue(),
			);
			rejectUpdater.schedule(rejectHarness.ctx);
			await rejectUpdater.whenIdle();

			assert.equal(rejectHarness.notifications.length, 1);
			assert.match(
				rejectHarness.notifications[0]?.message ?? "",
				/MODEL_FAILED/,
			);
			assert.equal(
				rejectHarness.notifications[0]?.message.includes("401 Unauthorized"),
				false,
			);

			// Hung provider that completely ignores AbortSignal -> cancellable() races and times out
			const hungHarness = createHarness({
				cwd: projectDir,
				streamHandler: () => new Promise<AssistantMessage>(() => {}),
			});
			const hungUpdater = createProgressUpdater(
				hungHarness.host,
				createSerialQueue(),
				{ timeoutMs: 40 },
			);
			const startMs = Date.now();
			hungUpdater.schedule(hungHarness.ctx);
			await hungUpdater.whenIdle();
			assert.ok(Date.now() - startMs < 1000);
			assert.equal(hungHarness.notifications.length, 1);
			assert.match(hungHarness.notifications[0]?.message ?? "", /TIMEOUT/);
		});

		test("skips untracked projects, missing/unregistered models, incomplete turns, and oversized contexts", async () => {
			// 1. Untracked project -> skipped silently without calling streamSimple
			const untrackedHarness = createHarness({ cwd: projectDir });
			const untrackedUpdater = createProgressUpdater(
				untrackedHarness.host,
				createSerialQueue(),
			);
			untrackedUpdater.schedule(untrackedHarness.ctx);
			await untrackedUpdater.whenIdle();
			assert.equal(untrackedHarness.streamCalls.length, 0);
			assert.equal(untrackedHarness.notifications.length, 0);

			// Enable tracking for remaining checks
			await runProgress(projectDir, { action: "start" });

			// 2. Incomplete turn (latest is user) -> skipped silently
			const incompleteHarness = createHarness({
				cwd: projectDir,
				entries: [makeUserEntry("u1", "Still waiting...")],
			});
			const incompleteUpdater = createProgressUpdater(
				incompleteHarness.host,
				createSerialQueue(),
			);
			incompleteUpdater.schedule(incompleteHarness.ctx);
			await incompleteUpdater.whenIdle();
			assert.equal(incompleteHarness.streamCalls.length, 0);
			assert.equal(incompleteHarness.notifications.length, 0);

			// 3. Missing model config -> MODEL_CONFIG warning, no stream call
			const noConfigHarness = createHarness({
				cwd: projectDir,
				settings: {},
			});
			const noConfigUpdater = createProgressUpdater(
				noConfigHarness.host,
				createSerialQueue(),
			);
			noConfigUpdater.schedule(noConfigHarness.ctx);
			await noConfigUpdater.whenIdle();
			assert.equal(noConfigHarness.streamCalls.length, 0);
			assert.match(
				noConfigHarness.notifications[0]?.message ?? "",
				/MODEL_CONFIG/,
			);

			// 4. Unregistered model -> MODEL_UNAVAILABLE warning, no stream call
			const missingModelHarness = createHarness({ cwd: projectDir });
			missingModelHarness.setModelLookup(() => undefined);
			const missingModelUpdater = createProgressUpdater(
				missingModelHarness.host,
				createSerialQueue(),
			);
			missingModelUpdater.schedule(missingModelHarness.ctx);
			await missingModelUpdater.whenIdle();
			assert.equal(missingModelHarness.streamCalls.length, 0);
			assert.match(
				missingModelHarness.notifications[0]?.message ?? "",
				/MODEL_UNAVAILABLE/,
			);

			// 5. Small context window -> CONTEXT_LIMIT warning, no stream call
			const tinyModelHarness = createHarness({
				cwd: projectDir,
				model: makeModel({ contextWindow: 4096, maxTokens: 2048 }),
			});
			const tinyModelUpdater = createProgressUpdater(
				tinyModelHarness.host,
				createSerialQueue(),
			);
			tinyModelUpdater.schedule(tinyModelHarness.ctx);
			await tinyModelUpdater.whenIdle();
			assert.equal(tinyModelHarness.streamCalls.length, 0);
			assert.match(
				tinyModelHarness.notifications[0]?.message ?? "",
				/CONTEXT_LIMIT/,
			);
		});

		test("rejects malformed JSON, non-object JSON, oversized output, and invalid proposals with INVALID_PROPOSAL", async () => {
			await runProgress(projectDir, { action: "start" });

			const badOutputs: string[] = [
				"not json at all",
				"[]",
				'"just a string"',
				'{"tasks":[],"extra":1}',
				'{"tasks":"not-an-array"}',
				JSON.stringify({
					tasks: [
						{
							id: "task-unknown",
							title: "Bad ID",
							description: "Should fail mergeUpdates",
							steps: [],
						},
					],
				}),
				`{"tasks":[{"id":null,"title":"Huge","description":"${"x".repeat(65000)}","steps":[{"id":null,"description":"s","status":null,"blocked_by":null}]}]}`,
			];

			for (const badText of badOutputs) {
				const harness = createHarness({
					cwd: projectDir,
					streamHandler: () => Promise.resolve(makeAssistantMessage(badText)),
				});
				const updater = createProgressUpdater(
					harness.host,
					createSerialQueue(),
				);
				updater.schedule(harness.ctx);
				await updater.whenIdle();

				assert.equal(
					harness.notifications.length,
					1,
					`Expected warning for output: ${badText.slice(0, 40)}`,
				);
				assert.match(
					harness.notifications[0]?.message ?? "",
					/INVALID_PROPOSAL/,
				);
			}

			const saved = await runProgress(projectDir, { action: "read" });
			assert.equal(saved.document?.revision, 0);
			assert.deepEqual(saved.document?.tasks, []);
		});

		test("discards stale proposal with CONFLICT when progress.json changes while stream is in flight", async () => {
			await runProgress(projectDir, { action: "start" });

			const harness = createHarness({
				cwd: projectDir,
				streamHandler: async () => {
					// Concurrent external write bumps revision from 0 to 1
					await runProgress(projectDir, {
						action: "add_task",
						expected_revision: 0,
						title: "External task",
						description: "Written by CLI",
						steps: ["CLI step"],
					});
					return makeAssistantMessage(
						JSON.stringify({
							tasks: [
								{
									id: null,
									title: "Stale bg task",
									description: "Based on rev 0",
									steps: [
										{
											id: null,
											description: "Step",
											status: "working",
											blocked_by: null,
										},
									],
								},
							],
						}),
					);
				},
			});

			const updater = createProgressUpdater(harness.host, createSerialQueue());
			updater.schedule(harness.ctx);
			await updater.whenIdle();

			assert.equal(harness.notifications.length, 1);
			assert.match(harness.notifications[0]?.message ?? "", /CONFLICT/);

			const saved = await runProgress(projectDir, { action: "read" });
			assert.equal(saved.document?.revision, 1);
			assert.equal(saved.document?.tasks.length, 1);
			assert.equal(saved.document?.tasks[0]?.title, "External task");
		});

		test("suppresses usage and write when session changes or shutdown occurs mid-flight", async () => {
			await runProgress(projectDir, { action: "start" });
			let resolveStream!: (msg: AssistantMessage) => void;
			const harness = createHarness({
				cwd: projectDir,
				streamHandler: () =>
					new Promise<AssistantMessage>((resolve) => {
						resolveStream = resolve;
					}),
			});

			const updater = createProgressUpdater(harness.host, createSerialQueue());
			updater.schedule(harness.ctx);
			while (harness.streamCalls.length === 0) {
				await new Promise((r) => setTimeout(r, 5));
			}

			// Simulate switching sessions mid-flight
			harness.setSessionId("session-2");
			resolveStream(
				makeAssistantMessage(
					JSON.stringify({
						tasks: [
							{
								id: null,
								title: "Wrong session task",
								description: "Must not persist",
								steps: [
									{
										id: null,
										description: "Step",
										status: "working",
										blocked_by: null,
									},
								],
							},
						],
					}),
				),
			);
			await updater.whenIdle();

			assert.equal(harness.appendedEntries.length, 0);
			assert.equal(harness.notifications.length, 0);
			const saved = await runProgress(projectDir, { action: "read" });
			assert.equal(saved.document?.revision, 0);
		});

		test("routes warnings to stderr when hasUI is false or during finishBeforeExit", async () => {
			await runProgress(projectDir, { action: "start" });
			const stderr = captureConsoleError();
			try {
				// Non-UI mode
				const headless = createHarness({
					cwd: projectDir,
					hasUI: false,
					streamHandler: () =>
						Promise.resolve(makeAssistantMessage("bad json")),
				});
				const updater1 = createProgressUpdater(
					headless.host,
					createSerialQueue(),
				);
				updater1.schedule(headless.ctx);
				await updater1.whenIdle();
				assert.equal(headless.notifications.length, 0);
				assert.ok(
					stderr.messages.some(
						(m) =>
							m.includes("INVALID_PROPOSAL") &&
							m.includes("next finished reply"),
					),
				);

				// Exiting with failure (even when hasUI is true, errors go to stderr with exit message)
				let resolveExitStream!: (msg: AssistantMessage) => void;
				const exiting = createHarness({
					cwd: projectDir,
					hasUI: true,
					streamHandler: () =>
						new Promise<AssistantMessage>((resolve) => {
							resolveExitStream = resolve;
						}),
				});
				const updater2 = createProgressUpdater(
					exiting.host,
					createSerialQueue(),
				);
				updater2.schedule(exiting.ctx);
				while (exiting.streamCalls.length === 0) {
					await new Promise((r) => setTimeout(r, 5));
				}
				const exitDone = updater2.finishBeforeExit();
				resolveExitStream(makeAssistantMessage("{invalid"));
				await exitDone;

				assert.equal(exiting.notifications.length, 0);
				assert.ok(
					stderr.messages.some(
						(m) =>
							m.includes("INVALID_PROPOSAL") &&
							m.includes("Exiting without a confirmed progress update."),
					),
				);
			} finally {
				stderr.restore();
			}
		});

		test("does not throw unhandled rejection when Pi 1.6 ExtensionContext getters and host.appendEntry become stale mid-flight", async () => {
			await runProgress(projectDir, { action: "start" });
			const stderr = captureConsoleError();
			let stale = false;
			const staleError = () =>
				new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			let rejectStream!: (err: unknown) => void;
			const h = createHarness({
				cwd: projectDir,
				hasUI: true,
				streamHandler: () =>
					new Promise<AssistantMessage>((_resolve, reject) => {
						rejectStream = reject;
					}),
			});
			const guardedHost: Pick<ExtensionAPI, "getSettings" | "appendEntry"> = {
				getSettings: () => h.host.getSettings(),
				appendEntry: (customType: string, data?: unknown): void => {
					if (stale) throw staleError();
					h.host.appendEntry(customType, data);
				},
			};
			const realCtx = h.ctx;
			const guardedCtx = new Proxy(realCtx, {
				get(target, prop, receiver) {
					if (stale) {
						throw staleError();
					}
					return Reflect.get(target, prop, receiver);
				},
			});
			try {
				const updater = createProgressUpdater(guardedHost, createSerialQueue());
				updater.schedule(guardedCtx);
				while (h.streamCalls.length === 0) {
					await new Promise((r) => setTimeout(r, 5));
				}
				// Simulate Pi 1.6 session disposal invalidating ALL ctx getters & appendEntry while request fails.
				stale = true;
				rejectStream(new Error("transport closed"));
				await updater.whenIdle();
				assert.equal(h.notifications.length, 0);

				// Calling schedule() with an already-stale ctx must also be a safe no-op.
				updater.schedule(guardedCtx);
				await updater.whenIdle();
			} finally {
				stderr.restore();
			}
		});
	});
});
