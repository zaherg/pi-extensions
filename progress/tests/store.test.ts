import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import {
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
import {
	applyProgressUpdates,
	errorResult,
	ProgressError,
	progressPath,
	runProgress,
} from "../store.ts";

const CLI_PATH = resolve("progress/cli.ts");

async function assertProgressError(
	promise: Promise<unknown>,
	expectedCode: string,
): Promise<void> {
	let caught: unknown;
	try {
		await promise;
	} catch (error: unknown) {
		caught = error;
	}
	assert.ok(
		caught instanceof ProgressError,
		`Expected ProgressError, got ${String(caught)}`,
	);
	assert.equal(caught.code, expectedCode);
}

function spawnCli(
	args: readonly string[],
	stdin: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

	beforeEach(async () => {
		originalHome = process.env.HOME;
		rootTmp = await realpath(
			await mkdtemp(join(tmpdir(), "pi-progress-store-")),
		);
		homeDir = join(rootTmp, "home");
		projectDir = join(rootTmp, "work", "alpha-project");
		await mkdir(homeDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		process.env.HOME = homeDir;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await rm(rootTmp, { recursive: true, force: true });
	});

	test("enforces canonical path resolution, symlink refusal, and basename PROJECT_COLLISION", async () => {
		const alias = join(rootTmp, "alias-name");
		await symlink(projectDir, alias);
		const started = await runProgress(alias, { action: "start" });
		assert.equal(
			started.path,
			join(homeDir, ".config", "ai-sessions", "alpha-project", "progress.json"),
		);
		assert.equal(started.document?.project, projectDir);

		await assertProgressError(progressPath("/"), "INVALID_PROJECT");

		const otherSameBasename = join(rootTmp, "other", "alpha-project");
		await mkdir(otherSameBasename, { recursive: true });
		await assertProgressError(
			runProgress(otherSameBasename, { action: "read" }),
			"PROJECT_COLLISION",
		);

		// Refuses symlinked progress.json
		await rm(started.path);
		const decoy = join(rootTmp, "decoy.json");
		await writeFile(decoy, "{}");
		await symlink(decoy, started.path);
		await assertProgressError(
			runProgress(projectDir, { action: "read" }),
			"UNSAFE_PATH",
		);
	});

	test("supports untracked read, idempotent 0600 start, full CRUD roundtrip, and CONFLICT checks", async () => {
		const untracked = await runProgress(projectDir, { action: "read" });
		assert.equal(untracked.document, null);
		assert.equal(existsSync(join(homeDir, ".config")), false);

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

		const started = await runProgress(projectDir, { action: "start" });
		const fileStat = await lstat(started.path);
		assert.equal(fileStat.mode & 0o777, 0o600);

		const r1 = await runProgress(projectDir, {
			action: "add_task",
			expected_revision: 0,
			title: "Add search",
			description: "Local index",
			steps: ["Build index", "Add query handler"],
		});
		const task = r1.document?.tasks[0];
		const step1 = task?.steps[0];
		const step2 = task?.steps[1];
		assert.ok(task && step1 && step2);

		await assertProgressError(
			runProgress(projectDir, {
				action: "update_task",
				expected_revision: 0,
				task_id: task.id,
				title: "Stale",
			}),
			"CONFLICT",
		);

		await runProgress(projectDir, {
			action: "update_task",
			expected_revision: 1,
			task_id: task.id,
			title: "Add local search",
		});
		await runProgress(projectDir, {
			action: "add_step",
			expected_revision: 2,
			task_id: task.id,
			description: "Write tests",
		});
		await runProgress(projectDir, {
			action: "update_step",
			expected_revision: 3,
			task_id: task.id,
			step_id: step1.id,
			status: "completed",
			blocked_by: null,
		});
		const final = await runProgress(projectDir, {
			action: "update_step",
			expected_revision: 4,
			task_id: task.id,
			step_id: step2.id,
			status: "blocked",
			blocked_by: "Waiting on spec",
		});

		assert.equal(final.document?.revision, 5);
		assert.equal(final.document?.tasks[0]?.title, "Add local search");
		assert.equal(final.document?.tasks[0]?.steps.length, 3);
		assert.equal(final.document?.tasks[0]?.steps[0]?.status, "completed");
		assert.equal(
			final.document?.tasks[0]?.steps[1]?.blocked_by,
			"Waiting on spec",
		);

		// Idempotent start preserves existing tasks
		const restarted = await runProgress(projectDir, { action: "start" });
		assert.deepEqual(restarted.document, final.document);
	});

	test("applyProgressUpdates merges in place, skips no-op writes, and atomically rejects invalid proposals", async () => {
		await runProgress(projectDir, { action: "start" });
		const init = await runProgress(projectDir, {
			action: "add_task",
			expected_revision: 0,
			title: "Auth",
			description: "Plan",
			steps: ["Design token", "Implement middleware"],
		});
		const task1 = init.document?.tasks[0];
		const step1 = task1?.steps[0];
		const step2 = task1?.steps[1];
		assert.ok(task1 && step1 && step2);

		const merged = await applyProgressUpdates(projectDir, 1, [
			{
				id: task1.id,
				title: "Auth v2",
				description: "Short-lived JWTs",
				steps: [
					{
						id: step1.id,
						description: "Design token",
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
				description: "Webhooks",
				steps: [
					{
						id: null,
						description: "Verify signatures",
						status: "blocked",
						blocked_by: "Missing secret",
					},
				],
			},
		]);
		assert.equal(merged.document?.revision, 2);
		assert.equal(merged.document?.tasks[0]?.steps[1]?.id, step2.id); // Omitted step preserved
		assert.equal(merged.document?.tasks[0]?.steps.length, 3);

		// No-op patch keeps revision unchanged
		const noop = await applyProgressUpdates(projectDir, 2, [
			{
				id: task1.id,
				title: "Auth v2",
				description: "Short-lived JWTs",
				steps: [],
			},
		]);
		assert.equal(noop.document?.revision, 2);

		// Atomic rollback when second patch in proposal is invalid
		const rawBefore = await readFile(merged.path, "utf8");
		await assertProgressError(
			applyProgressUpdates(projectDir, 2, [
				{ id: task1.id, title: "Mutated", description: "D", steps: [] },
				{
					id: task1.id,
					title: "Duplicate task patch",
					description: "D",
					steps: [],
				},
			]),
			"INVALID_PROPOSAL",
		);
		assert.equal(await readFile(merged.path, "utf8"), rawBefore);
	});

	test("waits on temporary lock contention, respects AbortSignal while locked, and serializes concurrent CLI writers", async () => {
		const started = await runProgress(projectDir, { action: "start" });
		const lockPath = join(dirname(started.path), "progress.lock");
		await writeFile(lockPath, '{"pid":99999}\n', { mode: 0o600 });

		// Abort while waiting on lock exits promptly with ABORTED
		const abortCtrl = new AbortController();
		setTimeout(() => {
			const err = new Error("Aborted");
			err.name = "AbortError";
			abortCtrl.abort(err);
		}, 40);
		await assert.rejects(
			runProgress(
				projectDir,
				{
					action: "add_task",
					expected_revision: 0,
					title: "Aborted",
					description: "D",
					steps: ["S"],
				},
				abortCtrl.signal,
			),
			(err: unknown) => errorResult(err).code === "ABORTED",
		);

		// Release lock after 60ms -> queued writer succeeds cleanly
		const timer = setTimeout(() => unlinkSync(lockPath), 60);
		try {
			const res = await runProgress(projectDir, {
				action: "add_task",
				expected_revision: 0,
				title: "After lock",
				description: "D",
				steps: ["S"],
			});
			assert.equal(res.document?.revision, 1);
		} finally {
			clearTimeout(timer);
		}

		// 5 concurrent CLI writers targeting revision 1 -> 1 succeeds, 4 fail with CONFLICT, zero leftover files
		const env = { ...process.env, HOME: homeDir };
		const results = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				spawnCli(
					["--cwd", projectDir],
					JSON.stringify({
						action: "add_task",
						expected_revision: 1,
						title: `Concurrent ${i}`,
						description: "D",
						steps: ["S"],
					}),
					env,
				),
			),
		);
		assert.equal(results.filter((r) => r.code === 0).length, 1);
		assert.equal(results.filter((r) => r.code === 1).length, 4);
		assert.deepEqual(await readdir(dirname(started.path)), ["progress.json"]);
	});
});
