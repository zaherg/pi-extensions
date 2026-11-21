import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { stripVTControlCharacters, TextDecoder } from "node:util";
import { resolveExecutable } from "../shared/executable.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 2_000;
const NUMBERED_LINE = /^ \d+[:-] /;
/** Pattern matching the recall hint RTK appends as the final line of filtered output. */
export const RECALL_HINT = /\n\[full output: rtk recall ([a-f0-9]{16})\]$/;

export const FAILURES = [
	"unavailable",
	"process",
	"timeout",
	"aborted",
	"input-limit",
	"output-limit",
	"protocol",
	"boundaries",
	"recovery",
	"unexpected",
] as const;

export type Failure = (typeof FAILURES)[number];

export interface ProcessOptions {
	cwd: string;
	configDirectory: string;
	signal?: AbortSignal | undefined;
	// Allow process overrides for isolated checks without exposing them to pipeline configs.
	executable?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	timeoutMs?: number | undefined;
	maxBytes?: number | undefined;
}

export type ProcessResult =
	| { ok: true; stdout: string }
	| { ok: false; reason: Failure };

export type Result =
	| { kind: "unchanged" }
	| { kind: "filtered"; text: string }
	| { kind: "failed"; reason: Failure };

/** Spawn RTK and pass input over stdin without invoking a shell. */
export async function invokeRtk(
	args: string[],
	input: string,
	options: ProcessOptions,
): Promise<ProcessResult> {
	const maxBytes = options.maxBytes ?? MAX_BYTES;
	if (options.signal?.aborted) return { ok: false, reason: "aborted" };
	if (Buffer.byteLength(input) > maxBytes) {
		return { ok: false, reason: "input-limit" };
	}

	// Resolve bare executables from PATH so Windows never runs an rtk.exe from cwd.
	const executable = resolveExecutable(options.executable ?? "rtk");
	if (!executable) return { ok: false, reason: "unavailable" };

	return new Promise<ProcessResult>((resolve) => {
		const grouped = process.platform !== "win32";
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: {
				...(options.env ?? process.env),
				RTK_CONFIG_DIR: options.configDirectory,
			},
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: grouped,
			windowsHide: true,
		});
		let settled = false;
		let failure: Failure | undefined;
		let size = 0;
		const output: Buffer[] = [];
		const finish = (result: ProcessResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const stop = (reason: Failure): void => {
			failure ??= reason;
			if (!child.pid) return;
			try {
				// Kill the entire isolated process group on Unix so spawned helpers terminate.
				if (grouped) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (error: unknown) {
				if (!isRecord(error) || error.code !== "ESRCH") {
					child.kill("SIGKILL");
				}
			}
		};
		const abort = (): void => stop("aborted");
		const timer = setTimeout(
			() => stop("timeout"),
			options.timeoutMs ?? TIMEOUT_MS,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();

		child.on("error", (error: NodeJS.ErrnoException): void => {
			const reason: Failure =
				isRecord(error) && error.code === "ENOENT" ? "unavailable" : "process";
			finish({ ok: false, reason: failure ?? reason });
		});
		child.stdin.on("error", (): void => stop("process"));
		const collect = (chunk: Buffer, stdout: boolean): void => {
			size += chunk.length;
			if (size > maxBytes) stop("output-limit");
			else if (stdout && !failure) output.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer): void => collect(chunk, true));
		// Count stderr toward the byte limit without exposing its contents.
		child.stderr.on("data", (chunk: Buffer): void => collect(chunk, false));
		child.on("close", (code: number | null): void => {
			if (failure || code !== 0) {
				finish({ ok: false, reason: failure ?? "process" });
			} else {
				try {
					// Decode UTF-8 strictly so corrupted recall bytes cannot compare equal.
					const stdout = new TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true,
					}).decode(Buffer.concat(output));
					finish({ ok: true, stdout });
				} catch {
					finish({ ok: false, reason: "protocol" });
				}
			}
		});
		child.stdin.end(input);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replacementText(stdout: string): string | undefined {
	let document: unknown;
	try {
		document = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isRecord(document) || !isRecord(document.hookSpecificOutput)) return undefined;
	const hook = document.hookSpecificOutput;
	if (hook.hookEventName !== "PostToolUse" || !isRecord(hook.updatedToolOutput))
		return undefined;
	const content = hook.updatedToolOutput.content;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block: unknown = content[0];
	if (
		!isRecord(block) ||
		block.type !== "text" ||
		typeof block.text !== "string"
	)
		return undefined;
	return block.text;
}

/** Verify that file headings, annotations, and notices still bind numbered lines to their files. */
export function preservesBoundaries(
	original: string,
	filtered: string,
): boolean {
	const lines = filtered.split("\n");
	let next = 0;
	let expectHeading = true;
	for (const line of original.split("\n")) {
		if (line.trim() === "") {
			expectHeading = true;
			continue;
		}
		// Reject headings that look like numbered match lines because the text protocol cannot distinguish them.
		if (expectHeading && NUMBERED_LINE.test(line)) return false;
		expectHeading = line === "[0 exact matches. Maybe you meant this?]";
		if (NUMBERED_LINE.test(line)) continue;
		const found = lines.indexOf(line, next);
		if (found < 0) return false;
		next = found + 1;
	}
	return true;
}

/** Predicate checking whether a filtered RTK output preserved required structural lines. */
export type StructureCheck = (original: string, filtered: string) => boolean;

/** Run one text result through RTK's post-tool pipeline and verify recall integrity. */
export async function filterPosthook(
	toolName: string,
	text: string,
	options: ProcessOptions,
	preservesStructure: StructureCheck,
	verifyRecall = true,
): Promise<Result> {
	const response = await invokeRtk(
		["hook", "claude"],
		JSON.stringify({
			hook_event_name: "PostToolUse",
			tool_name: toolName,
			// Omit tool inputs so prompts and metadata are never forwarded to RTK.
			tool_input: {},
			tool_response: { content: [{ type: "text", text }] },
		}),
		options,
	);
	if (!response.ok) return { kind: "failed", reason: response.reason };
	if (response.stdout.trim() === "") return { kind: "unchanged" };
	const filtered = replacementText(response.stdout);
	if (filtered === undefined || filtered === "") {
		return { kind: "failed", reason: "protocol" };
	}
	if (
		filtered === text ||
		Buffer.byteLength(filtered) >= Buffer.byteLength(text)
	) {
		return { kind: "unchanged" };
	}
	if (!preservesStructure(text, filtered)) {
		return { kind: "failed", reason: "boundaries" };
	}

	// Require a valid recall hash before accepting lossy output.
	const hash = RECALL_HINT.exec(filtered)?.[1];
	if (!hash) return { kind: "failed", reason: "recovery" };
	// Force a recall readback when requested or when the original text could contain the hash.
	if (
		verifyRecall ||
		RECALL_HINT.test(text) ||
		stripVTControlCharacters(text)
			.replace(/[\p{Cc}\p{Cf}]/gu, "")
			.includes(hash)
	) {
		const recalled = await invokeRtk(["recall", hash, "--full"], "", options);
		if (!recalled.ok) return { kind: "failed", reason: recalled.reason };
		if (recalled.stdout !== text) return { kind: "failed", reason: "recovery" };
	}
	if (options.signal?.aborted) return { kind: "failed", reason: "aborted" };
	return { kind: "filtered", text: filtered };
}
