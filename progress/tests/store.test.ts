import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	applyProgressUpdates,
	errorResult,
	MAX_BYTES,
	type ProgressDocument,
	ProgressError,
	progressPath,
	runProgress,
} from "../store.ts";

const CLI_PATH = resolve("progress/cli.ts");

function createHookedSignal(
	onCheck: (callIndex: number) => void,
): AbortSignal {
	let calls = 0;
	let aborted = false;
	let reason: unknown;
	const fake = {
		get aborted(): boolean {
			return aborted;
		},
		get reason(): unknown {
			return reason;
		},
		throwIfAborted(): void {
			calls++;
			try {
				onCheck(calls);
			} catch (error: unknown) {
				aborted = true;
				reason = error;
				throw error;
			}
		},
		addEventListener(): void {},
		removeEventListener(): void {},
	};
	return fake as unknown as AbortSignal;
}

function makeAbortError(message = "Aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

async function assertProgressError(
	promise: Promise<unknown>,
	expectedCode: string,
	messagePattern?: RegExp,
): Promise<ProgressError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error: unknown) {
		caught = error;
	}
	assert.ok(
		caught instanceof ProgressError,
		`Expected ProgressError(${expectedCode}), got: ${String(caught)}`,
	);
	assert.equal(caught.code, expectedCode);
	if (messagePattern) assert.match(caught.message, messagePattern);
	return caught;
}

interface CliRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function spawnCli(
	args: readonly string[],
	stdin: string,
	env: NodeJS.ProcessEnv,
): Promise<CliRunResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], {
			env,
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
		child.stdin.end(stdin);
	});
}

describe("progress/store", () => {
	let rootTmp = "";
	let homeDir = "";
	let projectDir = "";
	let originalHome: string | undefined;
	let originalXdg: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		originalXdg = process.env.XDG_CONFIG_HOME;
		rootTmp = await realpath(
			await mkdtemp(join(tmpdir(), "pi-progress-store-")),
		);
		homeDir = join(rootTmp, "home");
		projectDir = join(rootTmp, "work", "alpha-project");
		await mkdir(homeDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		process.env.HOME = homeDir;
		delete process.env.XDG_CONFIG_HOME;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		await rm(rootTmp, { recursive: true, force: true });
	});

	describe("path resolution and safety", () => {
		test("resolves storage under ~/.config/ai-sessions/<basename>/progress.json and ignores XDG_CONFIG_HOME", async () => {
			process.env.XDG_CONFIG_HOME = join(rootTmp, "custom-xdg");
			const expected = join(
				homeDir,
				".config",
				"ai-sessions",
				"alpha-project",
				"progress.json",
			);
			assert.equal(await progressPath(projectDir), expected);
		});

		test("resolves symlinked project cwd to canonical directory and basename", async () => {
			const alias = join(rootTmp, "alias-name");
			await symlink(projectDir, alias);
			const started = await runProgress(alias, { action: "start" });
			assert.equal(
				started.path,
				join(homeDir, ".config", "ai-sessions", "alpha-project", "progress.json"),
			);
			assert.equal(started.document?.project, projectDir);
		});

		test("rejects root directory and regular file as project cwd", async () => {
			await assertProgressError(progressPath("/"), "INVALID_PROJECT");
			const filePath = join(rootTmp, "not-a-dir.txt");
			await writeFile(filePath, "hello");
			await assertProgressError(progressPath(filePath), "INVALID_PROJECT");
		});

		test("refuses symlinked storage directories and symlinked progress.json", async () => {
			const decoy = join(rootTmp, "decoy");
			await mkdir(decoy, { recursive: true });

			// Symlinked .config
			await symlink(decoy, join(homeDir, ".config"));
			await assertProgressError(
				runProgress(projectDir, { action: "read" }),
				"UNSAFE_PATH",
			);
			await rm(join(homeDir, ".config"));

			// Symlinked ai-sessions
			await mkdir(join(homeDir, ".config"), { recursive: true });
			await symlink(decoy, join(homeDir, ".config", "ai-sessions"));
			await assertProgressError(
				runProgress(projectDir, { action: "start" }),
				"UNSAFE_PATH",
			);
			await rm(join(homeDir, ".config", "ai-sessions"));

			// Symlinked project storage dir
			await mkdir(join(homeDir, ".config", "ai-sessions"), {
				recursive: true,
			});
			await symlink(
				decoy,
				join(homeDir, ".config", "ai-sessions", "alpha-project"),
			);
			await assertProgressError(
				runProgress(projectDir, { action: "start" }),
				"UNSAFE_PATH",
			);
			await rm(join(homeDir, ".config", "ai-sessions", "alpha-project"));

			// Symlinked progress.json
			const storageDir = join(
				homeDir,
				".config",
				"ai-sessions",
				"alpha-project",
			);
			await mkdir(storageDir, { recursive: true });
			const targetJson = join(decoy, "real.json");
			await writeFile(targetJson, "{}");
			await symlink(targetJson, join(storageDir, "progress.json"));
			await assertProgressError(
				runProgress(projectDir, { action: "read" }),
				"UNSAFE_PATH",
			);
		});

		test("refuses progress.json when it is a directory instead of a regular file", async () => {
			const storageDir = join(
				homeDir,
				".config",
				"ai-sessions",
				"alpha-project",
			);
			await mkdir(join(storageDir, "progress.json"), { recursive: true });
			await assertProgressError(
				runProgress(projectDir, { action: "read" }),
				"UNSAFE_PATH",
			);
		});

		test("detects PROJECT_COLLISION when two directories share the same basename", async () => {
			const otherProject = join(rootTmp, "other", "alpha-project");
			await mkdir(otherProject, { recursive: true });

			const first = await runProgress(projectDir, { action: "start" });
			assert.ok(first.document);
			const before = await readFile(first.path, "utf8");

			await assertProgressError(
				runProgress(otherProject, { action: "read" }),
				"PROJECT_COLLISION",
			);
			await assertProgressError(
				runProgress(otherProject, { action: "start" }),
				"PROJECT_COLLISION",
			);
			assert.equal(await readFile(first.path, "utf8"), before);
		});
	});

	describe("happy-path CRUD and persistence roundtrip", () => {
		test("read on untracked project returns document: null without creating directories", async () => {
			const result = await runProgress(projectDir, { action: "read" });
			assert.equal(result.document, null);
			assert.equal(
				result.path,
				join(homeDir, ".config", "ai-sessions", "alpha-project", "progress.json"),
			);
			assert.equal(existsSync(join(homeDir, ".config")), false);
		});

		test("start creates 0700 dirs, 0600 compact file with trailing newline, and is idempotent", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			assert.ok(started.document);
			assert.equal(started.document.version, 1);
			assert.equal(started.document.project, projectDir);
			assert.equal(started.document.revision, 0);
			assert.deepEqual(started.document.tasks, []);
			assert.equal(
				new Date(started.document.updated_at).toISOString(),
				started.document.updated_at,
			);

			const raw = await readFile(started.path, "utf8");
			assert.ok(raw.endsWith("\n"));
			assert.equal(raw.trimEnd().includes("\n"), false);
			assert.deepEqual(JSON.parse(raw), started.document);

			const dirStat = await lstat(dirname(started.path));
			const fileStat = await lstat(started.path);
			assert.equal(dirStat.mode & 0o777, 0o700);
			assert.equal(fileStat.mode & 0o777, 0o600);

			// Add a task, then call start again -> existing data preserved
			const added = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "Ship feature",
				description: "Keep existing protocol intact",
				steps: ["Implement core"],
			});
			const restarted = await runProgress(projectDir, { action: "start" });
			assert.deepEqual(restarted.document, added.document);
		});

		test("full add_task, update_task, add_step, update_step, and read roundtrip", async () => {
			await runProgress(projectDir, { action: "start" });

			const r1 = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "Add search",
				description: "Use local index; no external service",
				steps: ["Build index", "Add query handler"],
			});
			assert.equal(r1.document?.revision, 1);
			assert.equal(r1.document?.tasks.length, 1);
			const task = r1.document?.tasks[0];
			assert.ok(task);
			assert.match(task.id, /^task-[0-9a-f-]+$/);
			assert.equal(task.steps.length, 2);
			const step1 = task.steps[0];
			const step2 = task.steps[1];
			assert.ok(step1 && step2);
			assert.match(step1.id, /^step-[0-9a-f-]+$/);
			assert.equal(step1.status, null);
			assert.equal(step1.blocked_by, null);

			// update_task: title only
			const r2 = await runProgress(projectDir, {
				action: "update_task",
				expected_revision: 1,
				task_id: task.id,
				title: "Add local search",
			});
			assert.equal(r2.document?.revision, 2);
			assert.equal(r2.document?.tasks[0]?.title, "Add local search");
			assert.equal(
				r2.document?.tasks[0]?.description,
				"Use local index; no external service",
			);

			// update_task: description only
			const r3 = await runProgress(projectDir, {
				action: "update_task",
				expected_revision: 2,
				task_id: task.id,
				description: "Use local trigram index",
			});
			assert.equal(r3.document?.revision, 3);
			assert.equal(r3.document?.tasks[0]?.title, "Add local search");
			assert.equal(
				r3.document?.tasks[0]?.description,
				"Use local trigram index",
			);

			// add_step
			const r4 = await runProgress(projectDir, {
				action: "add_step",
				expected_revision: 3,
				task_id: task.id,
				description: "Write unit tests",
			});
			assert.equal(r4.document?.revision, 4);
			assert.equal(r4.document?.tasks[0]?.steps.length, 3);
			const step3 = r4.document?.tasks[0]?.steps[2];
			assert.ok(step3);
			assert.equal(step3.description, "Write unit tests");
			assert.equal(step3.status, null);

			// update_step: description only
			const r5 = await runProgress(projectDir, {
				action: "update_step",
				expected_revision: 4,
				task_id: task.id,
				step_id: step1.id,
				description: "Build trigram index",
			});
			assert.equal(r5.document?.revision, 5);
			assert.equal(
				r5.document?.tasks[0]?.steps[0]?.description,
				"Build trigram index",
			);
			assert.equal(r5.document?.tasks[0]?.steps[0]?.status, null);

			// update_step: working -> completed
			const r6 = await runProgress(projectDir, {
				action: "update_step",
				expected_revision: 5,
				task_id: task.id,
				step_id: step1.id,
				status: "working",
				blocked_by: null,
			});
			assert.equal(r6.document?.tasks[0]?.steps[0]?.status, "working");

			const r7 = await runProgress(projectDir, {
				action: "update_step",
				expected_revision: 6,
				task_id: task.id,
				step_id: step1.id,
				status: "completed",
				blocked_by: null,
			});
			assert.equal(r7.document?.tasks[0]?.steps[0]?.status, "completed");

			// update_step: blocked with reason + updated description
			const r8 = await runProgress(projectDir, {
				action: "update_step",
				expected_revision: 7,
				task_id: task.id,
				step_id: step2.id,
				description: "Add query handler after syntax sign-off",
				status: "blocked",
				blocked_by: "Waiting for approved query syntax",
			});
			assert.equal(r8.document?.tasks[0]?.steps[1]?.status, "blocked");
			assert.equal(
				r8.document?.tasks[0]?.steps[1]?.blocked_by,
				"Waiting for approved query syntax",
			);

			// update_step: reset back to null (not started)
			const r9 = await runProgress(projectDir, {
				action: "update_step",
				expected_revision: 8,
				task_id: task.id,
				step_id: step2.id,
				status: null,
				blocked_by: null,
			});
			assert.equal(r9.document?.tasks[0]?.steps[1]?.status, null);
			assert.equal(r9.document?.tasks[0]?.steps[1]?.blocked_by, null);

			// Read back from disk and verify exact roundtrip
			const readBack = await runProgress(projectDir, { action: "read" });
			assert.deepEqual(readBack.document, r9.document);
			assert.equal(readBack.document?.revision, 9);
		});

		test("reads pretty-printed valid v1 document without rewriting on read or no-op, compacts on mutation", async () => {
			const filePath = await progressPath(projectDir);
			await mkdir(dirname(filePath), { recursive: true });
			const prettyDoc: ProgressDocument = {
				version: 1,
				project: projectDir,
				revision: 2,
				updated_at: "2026-10-29T12:00:00.000Z",
				tasks: [
					{
						id: "task-pretty",
						title: "Existing task",
						description: "Preserved rationale",
						steps: [
							{
								id: "step-pretty",
								description: "First step",
								status: null,
								blocked_by: null,
							},
						],
					},
				],
			};
			const prettyText = `${JSON.stringify(prettyDoc, null, 2)}\n`;
			await writeFile(filePath, prettyText);

			const readRes = await runProgress(projectDir, { action: "read" });
			assert.deepEqual(readRes.document, prettyDoc);
			assert.equal(await readFile(filePath, "utf8"), prettyText);

			const noopRes = await applyProgressUpdates(projectDir, 2, []);
			assert.deepEqual(noopRes.document, prettyDoc);
			assert.equal(await readFile(filePath, "utf8"), prettyText);

			const mutated = await runProgress(projectDir, {
				action: "update_task",
				expected_revision: 2,
				task_id: "task-pretty",
				title: "Updated title",
			});
			assert.equal(mutated.document?.revision, 3);
			const compacted = await readFile(filePath, "utf8");
			assert.ok(compacted.endsWith("\n"));
			assert.equal(compacted.trimEnd().includes("\n"), false);
		});
	});

	describe("request and document validation edge cases", () => {
		test("rejects untracked mutations with NOT_STARTED", async () => {
			await assertProgressError(
				runProgress(projectDir, {
					action: "add_task",
					expected_revision: 0,
					title: "T",
					description: "D",
					steps: ["S"],
				}),
				"NOT_STARTED",
			);

			// Directory exists, progress.json does not
			const filePath = await progressPath(projectDir);
			await mkdir(dirname(filePath), { recursive: true });
			await assertProgressError(
				runProgress(projectDir, {
					action: "add_task",
					expected_revision: 0,
					title: "T",
					description: "D",
					steps: ["S"],
				}),
				"NOT_STARTED",
			);
		});

		test("rejects malformed requests with INVALID_REQUEST", async () => {
			await runProgress(projectDir, { action: "start" });
			const badRequests: unknown[] = [
				null,
				"read",
				[],
				{},
				{ action: "unknown" },
				{ action: "read", extra: 1 },
				{ action: "start", expected_revision: 0 },
				{
					action: "add_task",
					expected_revision: -1,
					title: "T",
					description: "D",
					steps: ["S"],
				},
				{
					action: "add_task",
					expected_revision: 0.5,
					title: "T",
					description: "D",
					steps: ["S"],
				},
				{
					action: "add_task",
					expected_revision: 0,
					title: "   ",
					description: "D",
					steps: ["S"],
				},
				{
					action: "add_task",
					expected_revision: 0,
					title: "T",
					description: "D",
					steps: [],
				},
				{
					action: "add_task",
					expected_revision: 0,
					title: "T",
					description: "D",
					steps: ["ok", "  "],
				},
				{
					action: "update_task",
					expected_revision: 0,
					task_id: "task-1",
				},
				{
					action: "update_task",
					expected_revision: 0,
					task_id: "task-1",
					title: "",
				},
				{
					action: "add_step",
					expected_revision: 0,
					task_id: "task-1",
					description: "   ",
				},
				{
					action: "update_step",
					expected_revision: 0,
					task_id: "task-1",
					step_id: "step-1",
				},
				{
					action: "update_step",
					expected_revision: 0,
					task_id: "task-1",
					step_id: "step-1",
					status: "working",
				},
				{
					action: "update_step",
					expected_revision: 0,
					task_id: "task-1",
					step_id: "step-1",
					blocked_by: null,
				},
				{
					action: "update_step",
					expected_revision: 0,
					task_id: "task-1",
					step_id: "step-1",
					status: "blocked",
					blocked_by: null,
				},
				{
					action: "update_step",
					expected_revision: 0,
					task_id: "task-1",
					step_id: "step-1",
					status: "blocked",
					blocked_by: "   ",
				},
				{
					action: "update_step",
					expected_revision: 0,
					task_id: "task-1",
					step_id: "step-1",
					status: "completed",
					blocked_by: "stale reason",
				},
				{
					action: "update_step",
					expected_revision: 0,
					task_id: "task-1",
					step_id: "step-1",
					status: "done",
					blocked_by: null,
				},
			];
			for (const req of badRequests) {
				await assertProgressError(
					runProgress(projectDir, req),
					"INVALID_REQUEST",
				);
			}
		});

		test("rejects stale expected_revision with CONFLICT and unknown IDs with NOT_FOUND", async () => {
			await runProgress(projectDir, { action: "start" });
			const added = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "Task A",
				description: "Desc A",
				steps: ["Step A1"],
			});
			const taskA = added.document?.tasks[0];
			assert.ok(taskA);
			const added2 = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 1,
				title: "Task B",
				description: "Desc B",
				steps: ["Step B1"],
			});
			const stepB1 = added2.document?.tasks[1]?.steps[0];
			assert.ok(stepB1);

			// Stale expected_revision
			await assertProgressError(
				runProgress(projectDir, {
					action: "update_task",
					expected_revision: 1,
					task_id: taskA.id,
					title: "Stale update",
				}),
				"CONFLICT",
			);

			// Missing task ID
			await assertProgressError(
				runProgress(projectDir, {
					action: "update_task",
					expected_revision: 2,
					task_id: "task-does-not-exist",
					title: "Nope",
				}),
				"NOT_FOUND",
			);

			// Step ID from another task
			await assertProgressError(
				runProgress(projectDir, {
					action: "update_step",
					expected_revision: 2,
					task_id: taskA.id,
					step_id: stepB1.id,
					description: "Wrong task",
				}),
				"NOT_FOUND",
			);
		});

		test("rejects malformed/corrupt/oversized progress.json with INVALID_DOCUMENT without modifying file", async () => {
			const filePath = await progressPath(projectDir);
			await mkdir(dirname(filePath), { recursive: true });

			const cases: Array<string | Buffer> = [
				Buffer.from([0xff, 0xfe, 0xfd]), // invalid UTF-8
				"{not json",
				JSON.stringify({
					version: 2,
					project: projectDir,
					revision: 0,
					updated_at: "2026-10-29T12:00:00.000Z",
					tasks: [],
				}),
				JSON.stringify({
					version: 1,
					project: projectDir,
					revision: 0,
					updated_at: "2026-10-29T12:00:00Z", // non-canonical ISO (missing .000)
					tasks: [],
				}),
				JSON.stringify({
					version: 1,
					project: projectDir,
					revision: 0,
					updated_at: "2026-10-29T12:00:00.000Z",
					tasks: [],
					extra: true,
				}),
				JSON.stringify({
					version: 1,
					project: projectDir,
					revision: 0,
					updated_at: "2026-10-29T12:00:00.000Z",
					tasks: [
						{
							id: "bad id with spaces",
							title: "T",
							description: "D",
							steps: [
								{
									id: "step-1",
									description: "S",
									status: null,
									blocked_by: null,
								},
							],
						},
					],
				}),
				JSON.stringify({
					version: 1,
					project: projectDir,
					revision: 0,
					updated_at: "2026-10-29T12:00:00.000Z",
					tasks: [
						{
							id: "dup-id",
							title: "T",
							description: "D",
							steps: [
								{
									id: "dup-id",
									description: "S",
									status: null,
									blocked_by: null,
								},
							],
						},
					],
				}),
				JSON.stringify({
					version: 1,
					project: projectDir,
					revision: 0,
					updated_at: "2026-10-29T12:00:00.000Z",
					tasks: [
						{
							id: "task-empty-steps",
							title: "T",
							description: "D",
							steps: [],
						},
					],
				}),
				" ".repeat(MAX_BYTES + 1), // oversized
			];

			for (const payload of cases) {
				await writeFile(filePath, payload);
				await assertProgressError(
					runProgress(projectDir, { action: "read" }),
					"INVALID_DOCUMENT",
				);
				const preserved = await readFile(filePath);
				assert.deepEqual(
					preserved,
					Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8"),
				);
			}
		});

		test("rejects revision exhaustion and mutations exceeding MAX_BYTES", async () => {
			const filePath = await progressPath(projectDir);
			await mkdir(dirname(filePath), { recursive: true });
			const exhausted: ProgressDocument = {
				version: 1,
				project: projectDir,
				revision: Number.MAX_SAFE_INTEGER,
				updated_at: "2026-10-29T12:00:00.000Z",
				tasks: [],
			};
			await writeFile(filePath, `${JSON.stringify(exhausted)}\n`);
			await assertProgressError(
				runProgress(projectDir, {
					action: "add_task",
					expected_revision: Number.MAX_SAFE_INTEGER,
					title: "T",
					description: "D",
					steps: ["S"],
				}),
				"INVALID_DOCUMENT",
			);

			// Reset to rev 0 and try writing > 1 MiB
			const fresh: ProgressDocument = {
				version: 1,
				project: projectDir,
				revision: 0,
				updated_at: "2026-10-29T12:00:00.000Z",
				tasks: [],
			};
			const freshRaw = `${JSON.stringify(fresh)}\n`;
			await writeFile(filePath, freshRaw);
			await assertProgressError(
				runProgress(projectDir, {
					action: "add_task",
					expected_revision: 0,
					title: "Huge",
					description: "x".repeat(MAX_BYTES),
					steps: ["Step"],
				}),
				"INVALID_REQUEST",
				/1 MiB/,
			);
			assert.equal(await readFile(filePath, "utf8"), freshRaw);
		});
	});

	describe("applyProgressUpdates and mergeUpdates", () => {
		test("rejects untracked directory and stale/invalid revisions", async () => {
			await assertProgressError(
				applyProgressUpdates(projectDir, 0, []),
				"NOT_STARTED",
			);
			const filePath = await progressPath(projectDir);
			await mkdir(dirname(filePath), { recursive: true });
			await assertProgressError(
				applyProgressUpdates(projectDir, 0, []),
				"NOT_STARTED",
			);

			await runProgress(projectDir, { action: "start" });
			await assertProgressError(
				applyProgressUpdates(projectDir, -1, []),
				"INVALID_REQUEST",
			);
			await assertProgressError(
				applyProgressUpdates(projectDir, 1, []),
				"CONFLICT",
			);
		});

		test("merges new tasks, updates existing tasks/steps in place, preserves omitted items, and skips no-op writes", async () => {
			await runProgress(projectDir, { action: "start" });
			const initial = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "Auth",
				description: "Initial plan",
				steps: ["Design token format", "Implement middleware"],
			});
			const task1 = initial.document?.tasks[0];
			const step1 = task1?.steps[0];
			const step2 = task1?.steps[1];
			assert.ok(task1 && step1 && step2);

			// Apply multi-task update: update task1 (changing step1 + appending step3, omitting step2) AND add task2 with completed+blocked steps
			const merged = await applyProgressUpdates(projectDir, 1, [
				{
					id: task1.id,
					title: "Auth v2",
					description: "Use short-lived JWTs",
					steps: [
						{
							id: step1.id,
							description: "Design token format (done)",
							status: "completed",
							blocked_by: null,
						},
						{
							id: null,
							description: "Add refresh endpoint",
							status: "working",
							blocked_by: null,
						},
					],
				},
				{
					id: null,
					title: "Billing",
					description: "Stripe webhook verification",
					steps: [
						{
							id: null,
							description: "Verify signatures",
							status: "blocked",
							blocked_by: "Waiting for webhook secret",
						},
					],
				},
			]);

			assert.equal(merged.document?.revision, 2);
			assert.equal(merged.document?.tasks.length, 2);
			const updatedTask1 = merged.document?.tasks[0];
			const newTask2 = merged.document?.tasks[1];
			assert.ok(updatedTask1 && newTask2);
			assert.equal(updatedTask1.id, task1.id);
			assert.equal(updatedTask1.title, "Auth v2");
			assert.equal(updatedTask1.steps.length, 3);
			assert.equal(updatedTask1.steps[0]?.id, step1.id);
			assert.equal(updatedTask1.steps[0]?.status, "completed");
			// Omitted step2 preserved in original slot
			assert.equal(updatedTask1.steps[1]?.id, step2.id);
			assert.equal(updatedTask1.steps[1]?.description, "Implement middleware");
			assert.equal(updatedTask1.steps[1]?.status, null);
			// New step3 appended
			assert.match(updatedTask1.steps[2]?.id ?? "", /^step-/);
			assert.equal(updatedTask1.steps[2]?.status, "working");

			// New task2 appended with initial blocked step
			assert.match(newTask2.id, /^task-/);
			assert.equal(newTask2.steps[0]?.status, "blocked");
			assert.equal(newTask2.steps[0]?.blocked_by, "Waiting for webhook secret");

			// Updating task title/description with steps: [] preserves all steps
			const titleOnly = await applyProgressUpdates(projectDir, 2, [
				{
					id: newTask2.id,
					title: "Billing webhooks",
					description: "Stripe webhook verification",
					steps: [],
				},
			]);
			assert.equal(titleOnly.document?.revision, 3);
			assert.equal(titleOnly.document?.tasks[1]?.steps.length, 1);

			// Identical patch is a no-op: revision and updated_at stay unchanged
			const beforeTs = titleOnly.document?.updated_at;
			const identical = await applyProgressUpdates(projectDir, 3, [
				{
					id: newTask2.id,
					title: "Billing webhooks",
					description: "Stripe webhook verification",
					steps: [],
				},
			]);
			assert.equal(identical.document?.revision, 3);
			assert.equal(identical.document?.updated_at, beforeTs);
		});

		test("rejects malformed, duplicate, unknown-ID, or partially invalid proposals with INVALID_PROPOSAL atomically", async () => {
			await runProgress(projectDir, { action: "start" });
			const r1 = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "Task 1",
				description: "Desc 1",
				steps: ["Step 1"],
			});
			const r2 = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 1,
				title: "Task 2",
				description: "Desc 2",
				steps: ["Step 2"],
			});
			const task1 = r1.document?.tasks[0];
			const step1 = task1?.steps[0];
			const step2 = r2.document?.tasks[1]?.steps[0];
			assert.ok(task1 && step1 && step2);

			const beforeRaw = await readFile(r2.path, "utf8");

			const invalidProposals: unknown[] = [
				"not-an-array",
				{},
				[null],
				[{ id: null, title: "Missing steps", description: "D" }],
				[
					{
						id: null,
						title: "Extra key",
						description: "D",
						steps: [],
						extra: true,
					},
				],
				[
					{
						id: null,
						title: "Zero steps new task",
						description: "D",
						steps: [],
					},
				],
				[
					{
						id: "task-nonexistent",
						title: "T",
						description: "D",
						steps: [],
					},
				],
				// Duplicate task patch
				[
					{ id: task1.id, title: "A", description: "D", steps: [] },
					{ id: task1.id, title: "B", description: "D", steps: [] },
				],
				// Duplicate step patch
				[
					{
						id: task1.id,
						title: "Task 1",
						description: "Desc 1",
						steps: [
							{
								id: step1.id,
								description: "S1",
								status: "working",
								blocked_by: null,
							},
							{
								id: step1.id,
								description: "S1 again",
								status: "completed",
								blocked_by: null,
							},
						],
					},
				],
				// Cross-task step ID
				[
					{
						id: task1.id,
						title: "Task 1",
						description: "Desc 1",
						steps: [
							{
								id: step2.id,
								description: "Wrong owner",
								status: "working",
								blocked_by: null,
							},
						],
					},
				],
				// Non-null step ID on brand-new task
				[
					{
						id: null,
						title: "New",
						description: "Desc",
						steps: [
							{
								id: step1.id,
								description: "Stolen step",
								status: null,
								blocked_by: null,
							},
						],
					},
				],
				// Blocked without blocked_by
				[
					{
						id: task1.id,
						title: "Task 1",
						description: "Desc 1",
						steps: [
							{
								id: step1.id,
								description: "Step 1",
								status: "blocked",
								blocked_by: null,
							},
						],
					},
				],
				// Atomic rollback: patch 1 valid, patch 2 invalid
				[
					{
						id: task1.id,
						title: "Changed Task 1",
						description: "Desc 1",
						steps: [],
					},
					{
						id: null,
						title: "   ",
						description: "Invalid empty title",
						steps: [
							{
								id: null,
								description: "S",
								status: null,
								blocked_by: null,
							},
						],
					},
				],
			];

			for (const proposal of invalidProposals) {
				await assertProgressError(
					applyProgressUpdates(projectDir, 2, proposal),
					"INVALID_PROPOSAL",
				);
			}

			assert.equal(await readFile(r2.path, "utf8"), beforeRaw);
		});
	});

	describe("locking, cancellation, temp-file cleanup, and errorResult", () => {
		test("waits on temporary lock contention and succeeds once released", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			const lockPath = join(dirname(started.path), "progress.lock");
			await writeFile(lockPath, '{"pid":99999}\n', { mode: 0o600 });

			const releaseTimer = setTimeout(() => {
				unlinkSync(lockPath);
			}, 120);
			try {
				const added = await runProgress(projectDir, {
					action: "add_task",
					expected_revision: 0,
					title: "After lock",
					description: "Waited cleanly",
					steps: ["Done"],
				});
				assert.equal(added.document?.revision, 1);
				assert.equal(existsSync(lockPath), false);
			} finally {
				clearTimeout(releaseTimer);
			}
		});

		test("times out with LOCKED when lock persists past 2s and never steals the lock file", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			const lockPath = join(dirname(started.path), "progress.lock");
			const stalePayload =
				'{"pid":999999,"host":"old-host","started_at":"2020-01-01T00:00:00.000Z"}\n';
			await writeFile(lockPath, stalePayload, { mode: 0o600 });

			await assertProgressError(
				runProgress(projectDir, {
					action: "add_task",
					expected_revision: 0,
					title: "Blocked by lock",
					description: "Should not steal",
					steps: ["Step"],
				}),
				"LOCKED",
			);
			assert.equal(await readFile(lockPath, "utf8"), stalePayload);
		});

		test("supports AbortSignal before execution and while waiting for lock", async () => {
			const started = await runProgress(projectDir, { action: "start" });

			// Pre-aborted signal
			const pre = new AbortController();
			pre.abort(makeAbortError("Pre-aborted"));
			await assert.rejects(
				runProgress(projectDir, { action: "read" }, pre.signal),
				(err: unknown) => {
					const mapped = errorResult(err);
					assert.equal(mapped.code, "ABORTED");
					return true;
				},
			);

			// Abort while waiting for lock
			const lockPath = join(dirname(started.path), "progress.lock");
			await writeFile(lockPath, '{"pid":1}\n', { mode: 0o600 });
			const waitAbort = new AbortController();
			const startMs = Date.now();
			setTimeout(() => waitAbort.abort(makeAbortError("Wait aborted")), 60);
			await assert.rejects(
				runProgress(
					projectDir,
					{
						action: "add_task",
						expected_revision: 0,
						title: "Cancelled",
						description: "Cancelled",
						steps: ["Step"],
					},
					waitAbort.signal,
				),
				(err: unknown) => {
					assert.equal(errorResult(err).code, "ABORTED");
					return true;
				},
			);
			assert.ok(Date.now() - startMs < 1500);
		});

		test("releaseLock throws LOCK_CHANGED when lock is deleted while held", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			const lockPath = join(dirname(started.path), "progress.lock");

			// Call 3 is right after lock acquisition and write, before operation()
			const signal = createHookedSignal((callIndex) => {
				if (callIndex === 3) {
					assert.equal(existsSync(lockPath), true);
					unlinkSync(lockPath);
				}
			});

			await assertProgressError(
				runProgress(
					projectDir,
					{
						action: "add_task",
						expected_revision: 0,
						title: "Lock deleted mid-write",
						description: "Desc",
						steps: ["Step"],
					},
					signal,
				),
				"LOCK_CHANGED",
			);
		});

		test("releaseLock throws LOCK_CHANGED and preserves replacement lock when inode changes", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			const lockPath = join(dirname(started.path), "progress.lock");
			const replacement = '{"pid":424242,"owner":"replacement"}\n';

			const signal = createHookedSignal((callIndex) => {
				if (callIndex === 3) {
					unlinkSync(lockPath);
					writeFileSync(lockPath, replacement, { mode: 0o600 });
				}
			});

			await assertProgressError(
				runProgress(
					projectDir,
					{
						action: "add_task",
						expected_revision: 0,
						title: "Lock replaced",
						description: "Desc",
						steps: ["Step"],
					},
					signal,
				),
				"LOCK_CHANGED",
				/replacement lock was left untouched/i,
			);
			assert.equal(readFileSync(lockPath, "utf8"), replacement);
		});

		test("primary error inside critical section is NOT masked by LOCK_CHANGED during cleanup", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			const lockPath = join(dirname(started.path), "progress.lock");
			const replacement = '{"pid":55555,"owner":"other"}\n';

			// Delete lock -> primary CONFLICT must still be thrown
			const deletedSignal = createHookedSignal((callIndex) => {
				if (callIndex === 3) unlinkSync(lockPath);
			});
			await assertProgressError(
				runProgress(
					projectDir,
					{
						action: "add_task",
						expected_revision: 99,
						title: "Stale revision",
						description: "Desc",
						steps: ["Step"],
					},
					deletedSignal,
				),
				"CONFLICT",
			);

			// Replace lock -> primary CONFLICT must still be thrown AND replacement lock untouched
			const replacedSignal = createHookedSignal((callIndex) => {
				if (callIndex === 3) {
					unlinkSync(lockPath);
					writeFileSync(lockPath, replacement, { mode: 0o600 });
				}
			});
			await assertProgressError(
				runProgress(
					projectDir,
					{
						action: "add_task",
						expected_revision: 99,
						title: "Stale revision",
						description: "Desc",
						steps: ["Step"],
					},
					replacedSignal,
				),
				"CONFLICT",
			);
			assert.equal(readFileSync(lockPath, "utf8"), replacement);
		});

		test("cleans up temporary file when persist fails or aborts before rename", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			const storageDir = dirname(started.path);
			const beforeRaw = await readFile(started.path, "utf8");

			// Call 4 is inside persist() right after temp file is written & closed, before rename()
			const signal = createHookedSignal((callIndex) => {
				if (callIndex === 4) {
					throw makeAbortError("Aborted before rename");
				}
			});

			await assert.rejects(
				runProgress(
					projectDir,
					{
						action: "add_task",
						expected_revision: 0,
						title: "Aborted persist",
						description: "Desc",
						steps: ["Step"],
					},
					signal,
				),
				(err: unknown) => {
					assert.equal(errorResult(err).code, "ABORTED");
					return true;
				},
			);

			assert.equal(await readFile(started.path, "utf8"), beforeRaw);
			const files = await readdir(storageDir);
			assert.deepEqual(
				files.filter((name) => name.endsWith(".tmp")),
				[],
			);
			assert.equal(files.includes("progress.lock"), false);
		});

		test("cleans up temporary file on rename error (EISDIR) and read-only directory write error", async () => {
			const started = await runProgress(projectDir, { action: "start" });
			const storageDir = dirname(started.path);
			const backup = await readFile(started.path, "utf8");

			// Call 4 is right after temp file is written & closed, before rename(temporary, location.path).
			// Swapping location.path to a directory forces rename() to fail with EISDIR and triggers tmp cleanup.
			const renameFailSignal = createHookedSignal((callIndex) => {
				if (callIndex === 4) {
					unlinkSync(started.path);
					mkdirSync(started.path);
				}
			});
			try {
				await assert.rejects(
					runProgress(
						projectDir,
						{
							action: "add_task",
							expected_revision: 0,
							title: "Rename fails",
							description: "Desc",
							steps: ["Step"],
						},
						renameFailSignal,
					),
					(err: unknown) => {
						assert.equal(errorResult(err).code, "EISDIR");
						return true;
					},
				);
				const afterRenameErr = await readdir(storageDir);
				assert.deepEqual(
					afterRenameErr.filter((name) => name.endsWith(".tmp")),
					[],
				);
				assert.equal(afterRenameErr.includes("progress.lock"), false);
			} finally {
				await rm(started.path, { recursive: true, force: true });
				await writeFile(started.path, backup, { mode: 0o600 });
			}

			// Read-only storage directory fails before creating temp files
			await chmod(storageDir, 0o500);
			try {
				await assert.rejects(
					runProgress(projectDir, {
						action: "add_task",
						expected_revision: 0,
						title: "No permission",
						description: "Desc",
						steps: ["Step"],
					}),
					(err: unknown) => {
						assert.equal(errorResult(err).code, "EACCES");
						return true;
					},
				);
			} finally {
				await chmod(storageDir, 0o700);
			}
			const files = await readdir(storageDir);
			assert.deepEqual(
				files.filter((name) => name.endsWith(".tmp")),
				[],
			);
		});

		test("errorResult maps ProgressError, AbortError, ErrnoException, and unknown errors", () => {
			assert.deepEqual(
				errorResult(new ProgressError("CONFLICT", "Rev mismatch")),
				{ code: "CONFLICT", message: "Rev mismatch" },
			);
			assert.equal(errorResult(makeAbortError()).code, "ABORTED");

			const errnoErr = Object.assign(new Error("boom"), { code: "ENOENT" });
			assert.equal(errorResult(errnoErr).code, "ENOENT");

			const weirdErr = Object.assign(new Error("boom"), { code: "custom_err" });
			assert.equal(errorResult(weirdErr).code, "IO_ERROR");
			assert.equal(errorResult("non-error").code, "IO_ERROR");
		});
	});

	describe("concurrent multi-process CLI writers", () => {
		test("6 concurrent writers on revision 0 produce exactly 1 commit and 5 CONFLICT errors with zero corruption", async () => {
			await runProgress(projectDir, { action: "start" });
			const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };

			const results = await Promise.all(
				Array.from({ length: 6 }, (_, index) =>
					spawnCli(
						["--cwd", projectDir],
						JSON.stringify({
							action: "add_task",
							expected_revision: 0,
							title: `Concurrent task ${index}`,
							description: `Writer ${index}`,
							steps: [`Step ${index}`],
						}),
						env,
					),
				),
			);

			const successes = results.filter((r) => r.code === 0);
			const failures = results.filter((r) => r.code === 1);
			assert.equal(successes.length, 1);
			assert.equal(failures.length, 5);

			for (const failure of failures) {
				const parsed = JSON.parse(failure.stderr) as {
					code: string;
					message: string;
				};
				assert.equal(parsed.code, "CONFLICT");
			}

			const finalState = await runProgress(projectDir, { action: "read" });
			assert.equal(finalState.document?.revision, 1);
			assert.equal(finalState.document?.tasks.length, 1);
			const storageFiles = await readdir(dirname(finalState.path));
			assert.deepEqual(storageFiles, ["progress.json"]);
		});

		test("4 concurrent CLI writers retrying on CONFLICT serialize cleanly and persist all 4 tasks", async () => {
			await runProgress(projectDir, { action: "start" });
			const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };

			const writeWithRetry = async (index: number): Promise<void> => {
				for (let attempt = 0; attempt < 15; attempt++) {
					const readRes = await spawnCli(
						["--cwd", projectDir],
						JSON.stringify({ action: "read" }),
						env,
					);
					assert.equal(readRes.code, 0);
					const current = JSON.parse(readRes.stdout) as {
						document: ProgressDocument;
					};
					const writeRes = await spawnCli(
						["--cwd", projectDir],
						JSON.stringify({
							action: "add_task",
							expected_revision: current.document.revision,
							title: `Serialized task ${index}`,
							description: `Author ${index}`,
							steps: [`Work ${index}`],
						}),
						env,
					);
					if (writeRes.code === 0) return;
					const err = JSON.parse(writeRes.stderr) as { code: string };
					assert.equal(
						err.code === "CONFLICT" || err.code === "LOCKED",
						true,
						`Unexpected CLI error: ${writeRes.stderr}`,
					);
					await delay(10);
				}
				assert.fail(`Writer ${index} did not succeed within retry budget`);
			};

			await Promise.all([0, 1, 2, 3].map((i) => writeWithRetry(i)));

			const finalState = await runProgress(projectDir, { action: "read" });
			assert.equal(finalState.document?.revision, 4);
			const titles = (finalState.document?.tasks ?? [])
				.map((t) => t.title)
				.sort();
			assert.deepEqual(titles, [
				"Serialized task 0",
				"Serialized task 1",
				"Serialized task 2",
				"Serialized task 3",
			]);
			const storageFiles = await readdir(dirname(finalState.path));
			assert.deepEqual(storageFiles, ["progress.json"]);
		});
	});
});
