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

function makeUsage(): Usage {
	return {
		input: 120,
		output: 45,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 165,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

function userEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function assistantEntry(
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

function createSerialQueue() {
	const tails = new Map<string, Promise<void>>();
	return async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
		const prev = tails.get(path) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((r) => {
			release = r;
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

	test("selectProgressModel resolves default and nested progress.model overrides and rejects bad configs", () => {
		const def = makeModel({ provider: "anthropic", id: "claude-sonnet" });
		const nested = makeModel({
			provider: "openrouter",
			id: "deepseek/deepseek-v4.1-flash",
		});
		const registry = {
			find: (p: string, id: string) =>
				p === def.provider && id === def.id
					? def
					: p === nested.provider && id === nested.id
						? nested
						: undefined,
		};

		assert.equal(
			selectProgressModel(
				{
					defaultProvider: "anthropic",
					defaultModel: "claude-sonnet",
				} as ReturnType<ExtensionAPI["getSettings"]>,
				registry,
			),
			def,
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
			nested,
		);

		assert.throws(
			() =>
				selectProgressModel(
					{
						defaultProvider: "p",
						defaultModel: "m",
						progress: { model: "no-slash" },
					} as ReturnType<ExtensionAPI["getSettings"]> & { progress?: unknown },
					registry,
				),
			(err: unknown) =>
				err instanceof ProgressError && err.code === "MODEL_CONFIG",
		);
	});

	test("projectConversation filters non-dialog entries, redacts secrets, and enforces window limits", () => {
		const projected = projectConversation([
			userEntry("u1", "Use Authorization: Bearer supersecret123"),
			assistantEntry("a-tool", "calling tool", "toolUse"),
			assistantEntry("a-final", "Done with sk-1234567890abcdef1234", "stop"),
		]);
		assert.equal(projected.completed, true);
		assert.equal(projected.messages.length, 2);
		assert.equal(projected.messages[0]?.text.includes("supersecret123"), false);
		assert.equal(projected.messages[1]?.text.includes("sk-"), false);

		const many = Array.from({ length: 30 }, (_, i) =>
			i % 2 === 0
				? userEntry(`m${i}`, `U${i}`)
				: assistantEntry(`m${i}`, `A${i}`),
		);
		const capped = projectConversation(many);
		assert.equal(capped.messages.length, 24);
		assert.equal(capped.truncated, true);
	});

	test("createProgressUpdater persists redacted proposals, coalesces rapid turns, and discards stale CONFLICT proposals", async () => {
		await runProgress(projectDir, { action: "start" });
		const model = makeModel();
		let entries: SessionEntry[] = [
			userEntry("u1", "Build login with secret=INPUT_SECRET"),
			assistantEntry("a1", "Done"),
		];
		const notifications: Array<{ message: string; type: string | undefined }> =
			[];
		const appended: Array<{ customType: string; data: unknown }> = [];
		let streamImpl: (opts: {
			signal?: AbortSignal;
		}) => Promise<AssistantMessage> = async () =>
			makeAssistantMessage(
				JSON.stringify({
					tasks: [
						{
							id: null,
							title: "OAuth login",
							description: "Configured token=OUTPUT_SECRET",
							steps: [
								{
									id: null,
									description: "Verify callback",
									status: "completed",
									blocked_by: null,
								},
							],
						},
					],
				}),
			);

		const host = {
			getSettings: () =>
				({
					defaultProvider: model.provider,
					defaultModel: model.id,
				}) as ReturnType<ExtensionAPI["getSettings"]>,
			appendEntry: (customType: string, data?: unknown) => {
				appended.push({ customType, data });
			},
		} as Pick<ExtensionAPI, "getSettings" | "appendEntry">;

		const ctx = {
			cwd: projectDir,
			hasUI: true,
			ui: {
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
			},
			sessionManager: {
				getSessionId: () => "s1",
				buildSessionProjection: () => ({
					entries: entries.map((sourceEntry) => ({
						sourceEntry,
						messages:
							sourceEntry.type === "message" ? [sourceEntry.message] : [],
					})),
				}),
			},
			modelRegistry: {
				find: () => model,
				streamSimple: (
					_m: Model<Api>,
					_c: Context,
					opts: { signal?: AbortSignal } = {},
				) => ({
					result: () => streamImpl(opts),
				}),
			},
		} as unknown as ExtensionContext;

		const updater = createProgressUpdater(host, createSerialQueue());
		updater.schedule(ctx);
		await updater.whenIdle();

		const saved1 = await runProgress(projectDir, { action: "read" });
		assert.equal(saved1.document?.revision, 1);
		assert.equal(
			saved1.document?.tasks[0]?.description.includes("OUTPUT_SECRET"),
			false,
		);
		assert.equal(appended.length, 1);

		// Coalesces rapid schedules and aborts superseded stream
		let calls = 0;
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>((r) => {
			releaseFirst = r;
		});
		streamImpl = ({ signal }) => {
			calls += 1;
			if (calls === 1) {
				releaseFirst();
				return new Promise<AssistantMessage>((_res, rej) => {
					signal?.addEventListener("abort", () => rej(signal.reason));
				});
			}
			return Promise.resolve(makeAssistantMessage('{"tasks":[]}'));
		};
		updater.schedule(ctx);
		await firstStarted;
		entries = [...entries, userEntry("u2", "T2"), assistantEntry("a2", "R2")];
		updater.schedule(ctx);
		entries = [...entries, userEntry("u3", "T3"), assistantEntry("a3", "R3")];
		updater.schedule(ctx);
		await updater.whenIdle();
		assert.equal(calls, 2);

		// Concurrent foreground mutation while stream is in flight -> CONFLICT warning, foreground state preserved
		let resumeConflictStream!: (msg: AssistantMessage) => void;
		let conflictStreamStarted!: () => void;
		const startedConflict = new Promise<void>((r) => {
			conflictStreamStarted = r;
		});
		streamImpl = () => {
			conflictStreamStarted();
			return new Promise<AssistantMessage>((r) => {
				resumeConflictStream = r;
			});
		};
		updater.schedule(ctx);
		await startedConflict;
		await runProgress(projectDir, {
			action: "add_task",
			expected_revision: 1,
			title: "Foreground task",
			description: "Wins over stale background proposal",
			steps: ["Done"],
		});
		resumeConflictStream(
			makeAssistantMessage(
				JSON.stringify({
					tasks: [
						{
							id: null,
							title: "Stale background task",
							description: "Should be discarded",
							steps: [
								{ id: null, description: "S", status: null, blocked_by: null },
							],
						},
					],
				}),
			),
		);
		await updater.whenIdle();
		const afterConflict = await runProgress(projectDir, { action: "read" });
		assert.equal(afterConflict.document?.revision, 2);
		assert.equal(afterConflict.document?.tasks.length, 2);
		assert.ok(notifications.some((n) => n.message.includes("CONFLICT")));
	});
});
