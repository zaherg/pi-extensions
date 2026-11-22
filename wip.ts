import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { resolveExecutable } from "./shared/executable.ts";

type NotifyLevel = NonNullable<Parameters<ExtensionUIContext["notify"]>[1]>;

const MISSING_BINARY_RE = /^spawn\b.*\bENOENT\b/i;

export default function wipExtension(pi: ExtensionAPI): void {
	let activeRun: symbol | undefined;
	let lifetime = new AbortController();

	pi.on("session_start", (): void => {
		activeRun = undefined;
		lifetime.abort();
		lifetime = new AbortController();
	});
	pi.on("session_shutdown", (): void => {
		activeRun = undefined;
		lifetime.abort();
	});

	pi.registerCommand("wip", {
		description: 'Run git add . && git commit -m "wip"',
		handler: async (
			args: string,
			ctx: ExtensionCommandContext,
		): Promise<void> => {
			const notify = (message: string, type: NotifyLevel): void => {
				try {
					if (ctx.hasUI) ctx.ui.notify(message, type);
				} catch {}
			};
			if (args.trim()) {
				notify("Usage: /wip (no arguments)", "error");
				return;
			}
			let idle: boolean;
			let cwd: string;
			try {
				idle = ctx.isIdle();
				cwd = ctx.cwd;
			} catch {
				return;
			}
			if (activeRun !== undefined || !idle) {
				notify(
					activeRun !== undefined
						? "/wip is already running."
						: "Wait for the current operation to finish before running /wip.",
					"warning",
				);
				return;
			}

			// Never run a git.exe planted in the project on Windows.
			const git = resolveExecutable("git");
			if (!git) {
				notify("git was not found on PATH.", "error");
				return;
			}

			const signal = lifetime.signal;
			const run = Symbol("wip");
			activeRun = run;
			let command = "git add .";
			try {
				const commands: string[][] = [
					["add", "."],
					["commit", "-m", "wip"],
				];
				for (const gitArgs of commands) {
					if (signal.aborted) return;
					command = `git ${gitArgs.join(" ")}`;
					const result = await pi.exec(git, gitArgs, {
						cwd,
						signal,
						timeout: 30_000,
						maxBuffer: 1024 * 1024,
					});
					if (result.code !== 0 || result.killed) {
						if (signal.aborted) return;
						if (
							!result.killed &&
							!result.stdout &&
							MISSING_BINARY_RE.test(result.stderr)
						) {
							notify("git was not found on PATH.", "error");
							return;
						}
						// Report status without forwarding hook output that could contain secrets.
						notify(
							result.killed
								? `${command} was interrupted or timed out. Check git status before retrying.`
								: `${command} failed (exit code ${result.code}).`,
							"error",
						);
						return;
					}
				}
				if (!signal.aborted) notify('Committed with message "wip".', "info");
			} catch {
				if (!signal.aborted)
					notify(`${command} could not be executed.`, "error");
			} finally {
				if (activeRun === run) activeRun = undefined;
			}
		},
	});
}
