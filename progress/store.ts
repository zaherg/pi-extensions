import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const ACTIONS = [
	"read",
	"add_task",
	"update_task",
	"add_step",
	"update_step",
] as const;
export const STATUSES = ["working", "blocked", "completed"] as const;
export const MAX_BYTES = 1024 * 1024;
export type StepStatus = null | (typeof STATUSES)[number];
export type Step = {
	id: string;
	description: string;
	status: StepStatus;
	blocked_by: string | null;
};
export type Task = {
	id: string;
	title: string;
	description: string;
	steps: Step[];
};
export type ProgressDocument = {
	version: 1;
	project: string;
	revision: number;
	updated_at: string;
	tasks: Task[];
};
export type ProgressResult = {
	path: string;
	document: ProgressDocument | null;
};
interface Location {
	project: string;
	root: string;
	directory: string;
	path: string;
}
type Request =
	| { action: "read" }
	| { action: "start" }
	| {
			action: "add_task";
			expected_revision: number;
			title: string;
			description: string;
			steps: string[];
	  }
	| {
			action: "update_task";
			expected_revision: number;
			task_id: string;
			title?: string;
			description?: string;
	  }
	| {
			action: "add_step";
			expected_revision: number;
			task_id: string;
			description: string;
	  }
	| {
			action: "update_step";
			expected_revision: number;
			task_id: string;
			step_id: string;
			description?: string;
			state?: { status: StepStatus; blocked_by: string | null };
	  };

export class ProgressError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ProgressError";
		this.code = code;
	}
}

function fail(code: string, message: string): never {
	throw new ProgressError(code, message);
}
function errno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
function object(
	value: unknown,
	code: string,
): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		fail(code, "Expected an object.");
}
function fields(
	value: Record<string, unknown>,
	required: string[],
	optional: string[],
	code: string,
): void {
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some(
			(key) => !required.includes(key) && !optional.includes(key),
		)
	) {
		fail(code, "Unsupported or missing fields.");
	}
}
function text(value: unknown, code: string): string {
	if (typeof value !== "string" || !value.trim())
		fail(code, "Expected nonempty text.");
	return value;
}
function integer(value: unknown, code: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		fail(code, "Expected a nonnegative safe integer revision.");
	return value;
}
function state(
	value: unknown,
	blockedBy: unknown,
	code: string,
): { status: StepStatus; blocked_by: string | null } {
	const status =
		value === null ? null : STATUSES.find((candidate) => candidate === value);
	if (status === undefined) fail(code, "Unknown step status.");
	if (status === "blocked")
		return { status, blocked_by: text(blockedBy, code) };
	if (blockedBy !== null)
		fail(code, "Nonblocked steps require blocked_by: null.");
	return { status, blocked_by: null };
}
function parseRequest(value: unknown): Request {
	const code = "INVALID_REQUEST";
	object(value, code);
	if (value.action === "read" || value.action === "start") {
		fields(value, ["action"], [], code);
		return { action: value.action };
	}
	const expected_revision = integer(value.expected_revision, code);
	switch (value.action) {
		case "add_task": {
			fields(
				value,
				["action", "expected_revision", "title", "description", "steps"],
				[],
				code,
			);
			if (!Array.isArray(value.steps) || !value.steps.length)
				fail(code, "A task needs at least one step.");
			return {
				action: value.action,
				expected_revision,
				title: text(value.title, code),
				description: text(value.description, code),
				steps: value.steps.map((step) => text(step, code)),
			};
		}
		case "update_task": {
			fields(
				value,
				["action", "expected_revision", "task_id"],
				["title", "description"],
				code,
			);
			if (
				!Object.hasOwn(value, "title") &&
				!Object.hasOwn(value, "description")
			)
				fail(code, "Supply a title or description to update.");
			return {
				action: value.action,
				expected_revision,
				task_id: text(value.task_id, code),
				...(Object.hasOwn(value, "title")
					? { title: text(value.title, code) }
					: {}),
				...(Object.hasOwn(value, "description")
					? { description: text(value.description, code) }
					: {}),
			};
		}
		case "add_step":
			fields(
				value,
				["action", "expected_revision", "task_id", "description"],
				[],
				code,
			);
			return {
				action: value.action,
				expected_revision,
				task_id: text(value.task_id, code),
				description: text(value.description, code),
			};
		case "update_step": {
			fields(
				value,
				["action", "expected_revision", "task_id", "step_id"],
				["description", "status", "blocked_by"],
				code,
			);
			const hasState =
				Object.hasOwn(value, "status") || Object.hasOwn(value, "blocked_by");
			if (!hasState && !Object.hasOwn(value, "description"))
				fail(code, "Supply a description or status to update.");
			return {
				action: value.action,
				expected_revision,
				task_id: text(value.task_id, code),
				step_id: text(value.step_id, code),
				...(Object.hasOwn(value, "description")
					? { description: text(value.description, code) }
					: {}),
				...(hasState
					? { state: state(value.status, value.blocked_by, code) }
					: {}),
			};
		}
		default:
			return fail(code, "Unknown progress action.");
	}
}

function parseDocument(value: unknown, project: string): ProgressDocument {
	const code = "INVALID_DOCUMENT";
	object(value, code);
	fields(
		value,
		["version", "project", "revision", "updated_at", "tasks"],
		[],
		code,
	);
	if (value.version !== 1) fail(code, "Unsupported progress version.");
	const savedProject = text(value.project, code);
	const revision = integer(value.revision, code);
	const updated_at = text(value.updated_at, code);
	const timestamp = new Date(updated_at);
	if (
		!Number.isFinite(timestamp.getTime()) ||
		timestamp.toISOString() !== updated_at
	)
		fail(code, "Invalid update timestamp.");
	if (!Array.isArray(value.tasks)) fail(code, "Expected a tasks array.");
	const ids = new Set<string>();
	const id = (candidate: unknown): string => {
		const result = text(candidate, code);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result) || ids.has(result))
			fail(code, "Invalid or duplicate task/step ID.");
		ids.add(result);
		return result;
	};
	const tasks = value.tasks.map((task: unknown): Task => {
		object(task, code);
		fields(task, ["id", "title", "description", "steps"], [], code);
		const taskId = id(task.id);
		if (!Array.isArray(task.steps) || !task.steps.length)
			fail(code, "A task needs at least one step.");
		return {
			id: taskId,
			title: text(task.title, code),
			description: text(task.description, code),
			steps: task.steps.map((step: unknown): Step => {
				object(step, code);
				fields(step, ["id", "description", "status", "blocked_by"], [], code);
				return {
					id: id(step.id),
					description: text(step.description, code),
					...state(step.status, step.blocked_by, code),
				};
			}),
		};
	});
	if (savedProject !== project)
		fail(
			"PROJECT_COLLISION",
			"This folder name is already assigned to a different canonical project path. Choose a distinct project folder name; the existing file was not changed.",
		);
	return { version: 1, project: savedProject, revision, updated_at, tasks };
}

export async function progressPath(cwd: string): Promise<string> {
	return (await locate(cwd)).path;
}
async function locate(cwd: string): Promise<Location> {
	const project = await realpath(cwd);
	if (!(await lstat(project)).isDirectory() || !basename(project))
		fail("INVALID_PROJECT", "Expected a named project directory.");
	const root = join(homedir(), ".config", "ai-sessions");
	const directory = join(root, basename(project));
	return { project, root, directory, path: join(directory, "progress.json") };
}
async function directoryExists(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink())
			fail(
				"UNSAFE_PATH",
				"Progress storage directories must be real directories, not symlinks.",
			);
		return true;
	} catch (error) {
		if (errno(error, "ENOENT")) return false;
		throw error;
	}
}
async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function ensureDirectory(path: string): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!errno(error, "EEXIST")) throw error;
	}
	if (!(await directoryExists(path)))
		fail(
			"UNSAFE_PATH",
			"Progress storage directory disappeared during initialization.",
		);
	// Persist directory entries too, including when another initializer created them.
	await syncDirectory(dirname(path));
}
async function available(
	location: Location,
	create: boolean,
): Promise<boolean> {
	if (create) {
		await ensureDirectory(dirname(location.root));
		await ensureDirectory(location.root);
		await ensureDirectory(location.directory);
		return true;
	}
	return (
		(await directoryExists(dirname(location.root))) &&
		(await directoryExists(location.root)) &&
		(await directoryExists(location.directory))
	);
}
async function readDocument(
	location: Location,
): Promise<ProgressDocument | null> {
	let handle: FileHandle;
	try {
		handle = await open(
			location.path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (errno(error, "ENOENT")) return null;
		if (errno(error, "ELOOP"))
			fail("UNSAFE_PATH", "progress.json must not be a symlink.");
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile())
			fail("UNSAFE_PATH", "progress.json must be a regular file.");
		if (info.size > MAX_BYTES)
			fail("INVALID_DOCUMENT", "Progress exceeds the 1 MiB size limit.");
		const bytes = await handle.readFile();
		if (bytes.length > MAX_BYTES)
			fail("INVALID_DOCUMENT", "Progress exceeds the 1 MiB size limit.");
		let value: unknown;
		try {
			value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch {
			return fail(
				"INVALID_DOCUMENT",
				"progress.json is not valid UTF-8 JSON; it was not changed.",
			);
		}
		return parseDocument(value, location.project);
	} finally {
		await handle.close();
	}
}

async function withLock<T>(
	location: Location,
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	const lockPath = join(location.directory, "progress.lock");
	const deadline = Date.now() + 2000;
	let handle: FileHandle | undefined;
	while (!handle) {
		signal?.throwIfAborted();
		try {
			handle = await open(lockPath, "wx", 0o600);
		} catch (error) {
			if (!errno(error, "EEXIST")) throw error;
			if (Date.now() >= deadline)
				fail(
					"LOCKED",
					"Progress is locked. Retry later. After a crashed writer, inspect progress.lock and remove it only after confirming no writer is active.",
				);
			await delay(25, undefined, { signal });
		}
	}
	try {
		await handle.writeFile(
			`${JSON.stringify({
				pid: process.pid,
				host: hostname(),
				started_at: new Date().toISOString(),
			})}\n`,
		);
		signal?.throwIfAborted();
		return await operation();
	} finally {
		let owned: Stats;
		try {
			owned = await handle.stat();
		} finally {
			await handle.close();
		}
		const current = await lstat(lockPath);
		if (current.ino !== owned.ino || current.dev !== owned.dev)
			fail(
				"LOCK_CHANGED",
				"Progress lock changed while held. The replacement lock was left untouched; re-read progress before retrying.",
			);
		await unlink(lockPath);
	}
}
async function persist(
	location: Location,
	document: ProgressDocument,
	signal?: AbortSignal,
): Promise<void> {
	const bytes = `${JSON.stringify(document)}\n`;
	if (Buffer.byteLength(bytes) > MAX_BYTES)
		fail("INVALID_REQUEST", "Progress would exceed the 1 MiB size limit.");
	const temporary = join(location.directory, `.progress-${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	let committed = false;
	try {
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		signal?.throwIfAborted();
		await rename(temporary, location.path);
		committed = true;
		await syncDirectory(location.directory);
	} catch (error) {
		if (committed)
			fail(
				"DURABILITY_UNCERTAIN",
				"Progress was replaced but directory sync failed. Re-read it before retrying; durability was not confirmed.",
			);
		throw error;
	} finally {
		if (!committed) await unlink(temporary);
	}
}
function newStep(description: string): Step {
	return {
		id: `step-${randomUUID()}`,
		description,
		status: null,
		blocked_by: null,
	};
}
function checkRevision(document: ProgressDocument, expected: number): void {
	integer(expected, "INVALID_REQUEST");
	if (document.revision !== expected)
		fail(
			"CONFLICT",
			`Progress revision changed (expected ${expected}, current ${document.revision}). Read again and reconsider the update; do not blindly retry.`,
		);
}
function advanceRevision(document: ProgressDocument): void {
	if (document.revision === Number.MAX_SAFE_INTEGER)
		fail("INVALID_DOCUMENT", "Progress revision is exhausted.");
	document.revision++;
	document.updated_at = new Date().toISOString();
}
function apply(
	document: ProgressDocument,
	request: Exclude<Request, { action: "read" | "start" }>,
): void {
	checkRevision(document, request.expected_revision);
	if (request.action === "add_task") {
		document.tasks.push({
			id: `task-${randomUUID()}`,
			title: request.title,
			description: request.description,
			steps: request.steps.map(newStep),
		});
	} else {
		const task = document.tasks.find(
			(candidate) => candidate.id === request.task_id,
		);
		if (!task) fail("NOT_FOUND", "Task ID not found.");
		if (request.action === "update_task") {
			if (request.title !== undefined) task.title = request.title;
			if (request.description !== undefined)
				task.description = request.description;
		} else if (request.action === "add_step") {
			task.steps.push(newStep(request.description));
		} else {
			const step = task.steps.find(
				(candidate) => candidate.id === request.step_id,
			);
			if (!step) fail("NOT_FOUND", "Step ID not found in the selected task.");
			if (request.description !== undefined)
				step.description = request.description;
			if (request.state) Object.assign(step, request.state);
		}
	}
	advanceRevision(document);
}

// Patches cannot delete, reorder, or invent IDs for existing records.
// Reuse the document validator so CLI and model writes share state invariants.
function mergeUpdates(document: ProgressDocument, updates: unknown): ProgressDocument {
	const code = "INVALID_REQUEST";
	if (!Array.isArray(updates)) fail(code, "Expected a task updates array.");
	const tasks = structuredClone(document.tasks);
	const seen = new Set<string>();
	for (const patch of updates) {
		object(patch, code);
		fields(patch, ["id", "title", "description", "steps"], [], code);
		const id = patch.id === null ? `task-${randomUUID()}` : text(patch.id, code);
		const index = tasks.findIndex((task) => task.id === id);
		if (patch.id !== null && index === -1) fail(code, "Task ID not found.");
		if (seen.has(id)) fail(code, "Duplicate task update.");
		seen.add(id);
		if (!Array.isArray(patch.steps)) fail(code, "Expected step updates.");
		const steps: unknown[] = index === -1 ? [] : [...tasks[index].steps];
		const seenSteps = new Set<string>();
		for (const step of patch.steps) {
			object(step, code);
			fields(step, ["id", "description", "status", "blocked_by"], [], code);
			const stepId = step.id === null ? `step-${randomUUID()}` : text(step.id, code);
			const stepIndex = index === -1 ? -1 : tasks[index].steps.findIndex((item) => item.id === stepId);
			if (step.id !== null && stepIndex === -1) fail(code, "Step ID not found in the selected task.");
			if (seenSteps.has(stepId)) fail(code, "Duplicate step update.");
			seenSteps.add(stepId);
			const replacement = { ...step, id: stepId };
			if (stepIndex === -1) steps.push(replacement);
			else steps[stepIndex] = replacement;
		}
		const validated = parseDocument({ ...document, tasks: [{ ...patch, id, steps }] }, document.project).tasks[0];
		if (index === -1) tasks.push(validated);
		else tasks[index] = validated;
	}
	return parseDocument({ ...document, tasks }, document.project);
}

/** Commit a background proposal atomically without extending the public CLI protocol. */
export async function applyProgressUpdates(
	cwd: string,
	expectedRevision: number,
	updates: unknown,
	signal?: AbortSignal,
): Promise<ProgressResult> {
	signal?.throwIfAborted();
	const location = await locate(cwd);
	if (!(await available(location, false)))
		fail("NOT_STARTED", "Tracking is not enabled.");
	return withLock(location, signal, async () => {
		const document = await readDocument(location);
		if (!document) fail("NOT_STARTED", "Tracking is not enabled.");
		checkRevision(document, expectedRevision);
		const next = mergeUpdates(document, updates);
		if (JSON.stringify(next.tasks) !== JSON.stringify(document.tasks)) {
			advanceRevision(next);
			await persist(location, next, signal);
		}
		return { path: location.path, document: next };
	});
}

export async function runProgress(
	cwd: string,
	input: unknown,
	signal?: AbortSignal,
): Promise<ProgressResult> {
	const request = parseRequest(input);
	signal?.throwIfAborted();
	const location = await locate(cwd);
	const exists = await available(location, request.action === "start");
	if (request.action === "read")
		return {
			path: location.path,
			document: exists ? await readDocument(location) : null,
		};
	if (!exists)
		fail(
			"NOT_STARTED",
			"Tracking is not enabled. Ask the user to run /progress start, or explicitly start through the CLI.",
		);
	return withLock(location, signal, async () => {
		let document = await readDocument(location);
		if (request.action === "start") {
			if (!document) {
				document = {
					version: 1,
					project: location.project,
					revision: 0,
					updated_at: new Date().toISOString(),
					tasks: [],
				};
				await persist(location, document, signal);
			}
		} else {
			if (!document)
				fail(
					"NOT_STARTED",
					"Tracking is not enabled. Ask the user to run /progress start, or explicitly start through the CLI.",
				);
			apply(document, request);
			await persist(location, document, signal);
		}
		return { path: location.path, document };
	});
}

export function errorResult(error: unknown): { code: string; message: string } {
	if (error instanceof ProgressError)
		return { code: error.code, message: error.message };
	if (error instanceof Error && error.name === "AbortError")
		return {
			code: "ABORTED",
			message:
				"Progress operation cancelled. Re-read before retrying if cancellation occurred during commit.",
		};
	const code =
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		/^E[A-Z0-9_]+$/.test(error.code)
			? error.code
			: "IO_ERROR";
	return {
		code,
		message: `Progress operation failed (${code}). Check filesystem access and re-read before retrying.`,
	};
}
