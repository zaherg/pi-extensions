import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 2_000;
const NUMBERED_LINE = /^ \d+[:-] /;
const RECALL_HINT = /\n\[full output: rtk recall ([a-f0-9]{16})\]$/;

export type Failure =
	| "unavailable"
	| "process"
	| "timeout"
	| "aborted"
	| "input-limit"
	| "output-limit"
	| "protocol"
	| "boundaries"
	| "recovery"
	| "unexpected";

export interface ProcessOptions {
	cwd: string;
	configDirectory: string;
	signal?: AbortSignal;
	// Overrides are for isolated checks, never loaded from pipeline configuration.
	executable?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	maxBytes?: number;
}

type ProcessResult =
	| { ok: true; stdout: string }
	| { ok: false; reason: Failure };

export type Result =
	| { kind: "unchanged" }
	| { kind: "filtered"; text: string }
	| { kind: "failed"; reason: Failure };

/** Send data through stdin, never a shell or the process argument list. */
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

	return new Promise((resolve) => {
		const grouped = process.platform !== "win32";
		const child = spawn(options.executable ?? "rtk", args, {
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
		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const stop = (reason: Failure) => {
			failure ??= reason;
			if (!child.pid) return;
			try {
				// RTK rules can spawn helpers. Kill the whole isolated group on Unix.
				if (grouped) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (error) {
				if (!isRecord(error) || error.code !== "ESRCH") {
					child.kill("SIGKILL");
				}
			}
		};
		const abort = () => stop("aborted");
		const timer = setTimeout(
			() => stop("timeout"),
			options.timeoutMs ?? TIMEOUT_MS,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();

		child.on("error", (error) => {
			const reason =
				isRecord(error) && error.code === "ENOENT" ? "unavailable" : "process";
			finish({ ok: false, reason: failure ?? reason });
		});
		child.stdin.on("error", () => stop("process"));
		const collect = (chunk: Buffer, stdout: boolean) => {
			size += chunk.length;
			if (size > maxBytes) stop("output-limit");
			else if (stdout && !failure) output.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
		// Count stderr toward the limit, but never expose its contents.
		child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
		child.on("close", (code) => {
			if (failure || code !== 0) {
				finish({ ok: false, reason: failure ?? "process" });
			} else {
				try {
					// Lossy UTF-8 decoding could make corrupted recall bytes compare equal.
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
	if (!isRecord(document) || !isRecord(document.hookSpecificOutput)) return;
	const hook = document.hookSpecificOutput;
	if (hook.hookEventName !== "PostToolUse" || !isRecord(hook.updatedToolOutput))
		return;
	const content = hook.updatedToolOutput.content;
	if (!Array.isArray(content) || content.length !== 1) return;
	const block: unknown = content[0];
	if (
		!isRecord(block) ||
		block.type !== "text" ||
		typeof block.text !== "string"
	)
		return;
	return block.text;
}

/** FFF headings, annotations and notices bind numbered lines to files/pages. */
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
		// FFF emits filenames verbatim at group boundaries. A numbered-looking
		// filename is indistinguishable from a match in this text-only protocol.
		if (expectHeading && NUMBERED_LINE.test(line)) return false;
		expectHeading = line === "[0 exact matches. Maybe you meant this?]";
		if (NUMBERED_LINE.test(line)) continue;
		const found = lines.indexOf(line, next);
		if (found < 0) return false;
		next = found + 1;
	}
	return true;
}

export async function filterFfgrep(
	text: string,
	options: ProcessOptions,
): Promise<Result> {
	const response = await invokeRtk(
		["hook", "claude"],
		JSON.stringify({
			hook_event_name: "PostToolUse",
			tool_name: "ffgrep",
			// RTK 1.1 does not expose unknown-tool inputs as pipeline facts.
			// Do not forward prompts, transcript paths, or unrelated tool metadata.
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
	if (!preservesBoundaries(text, filtered)) {
		return { kind: "failed", reason: "boundaries" };
	}

	// Refuse lossy output when recall was disabled, failed, or changed format.
	// Readback also prevents a source line resembling a recall hint from being trusted.
	const hash = RECALL_HINT.exec(filtered)?.[1];
	if (!hash) return { kind: "failed", reason: "recovery" };
	const recalled = await invokeRtk(["recall", hash, "--full"], "", options);
	if (!recalled.ok) return { kind: "failed", reason: recalled.reason };
	if (recalled.stdout !== text) return { kind: "failed", reason: "recovery" };
	if (options.signal?.aborted) return { kind: "failed", reason: "aborted" };
	return { kind: "filtered", text: filtered };
}
