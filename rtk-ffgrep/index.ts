import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Failure, filterFfgrep, type Result } from "./bridge.ts";

const FAILURE_MESSAGES: Record<Failure, string> = {
	unavailable: "rtk was not found in PATH",
	process: "the RTK process failed",
	timeout: "RTK exceeded the two-second process timeout",
	aborted: "filtering was cancelled",
	"input-limit": "the input exceeded the two-MiB limit",
	"output-limit": "RTK exceeded the two-MiB output limit",
	protocol: "RTK returned an unsupported response",
	boundaries: "a file heading or notice could not be verified",
	recovery: "the original output could not be verified through RTK recall",
	unexpected: "an unexpected adapter error occurred",
};

export default function rtkFfgrep(pi: ExtensionAPI) {
	const configDirectory = join(homedir(), ".config", "rtk");
	const lifetime = new AbortController();
	const pending = new Set<Promise<Result>>();
	const reported = new Set<Failure>();

	const warn = (reason: Failure, ctx: ExtensionContext) => {
		if (reason === "aborted" || reported.has(reason)) return;
		reported.add(reason);
		const message = `[rtk-ffgrep] ${FAILURE_MESSAGES[reason]}; original output retained.`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.warn(message);
	};

	pi.on("tool_result", async (event, ctx) => {
		if (
			event.toolName !== "ffgrep" ||
			event.isError ||
			event.structuredContent !== undefined ||
			event.content.length !== 1 ||
			process.env.RTK_DISABLED === "1" ||
			lifetime.signal.aborted
		)
			return;
		const block = event.content[0];
		if (block?.type !== "text" || block.text === "" || ctx.signal?.aborted)
			return;
		const signal = ctx.signal
			? AbortSignal.any([ctx.signal, lifetime.signal])
			: lifetime.signal;
		const work = filterFfgrep(block.text, {
			cwd: ctx.cwd,
			configDirectory,
			signal,
		});
		pending.add(work);
		try {
			const result = await work;
			if (result.kind === "failed") warn(result.reason, ctx);
			if (result.kind !== "filtered" || signal.aborted) return;
			// Keep Pi's details, usage, error state, and block metadata untouched.
			return { content: [{ ...block, text: result.text }] };
		} catch {
			// Never expose subprocess output or searched source through diagnostics.
			warn("unexpected", ctx);
		} finally {
			pending.delete(work);
		}
	});

	pi.on("session_shutdown", async () => {
		lifetime.abort();
		await Promise.allSettled([...pending]);
	});
}
