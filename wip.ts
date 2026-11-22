import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveExecutable } from "./shared/executable.ts";
import { bindSession, type SessionSnapshot } from "./shared/session.ts";

const MISSING_BINARY_RE = /^spawn\b.*\bENOENT\b/i;

export default function wipExtension(pi: ExtensionAPI): void {
	const session = bindSession(pi);
	let activeRun: symbol | undefined;

	session.onLifecycle("session_start", (): void => {
		activeRun = undefined;
	});
	session.onLifecycle("session_shutdown", (): void => {
		activeRun = undefined;
	});

	session.registerCommand("wip", {
		description: 'Run git add . && git commit -m "wip"',
		handler: async (args: string, snap: SessionSnapshot): Promise<void> => {
			if (args.trim()) {
				snap.notify("Usage: /wip (no arguments)", "error");
				return;
			}
			const idle = snap.isIdle();
			if (idle === undefined) return;
			if (activeRun !== undefined || !idle) {
				snap.notify(
					activeRun !== undefined
						? "/wip is already running."
						: "Wait for the current operation to finish before running /wip.",
					"warning",
				);
				return;
			}

			const git = resolveExecutable("git");
			if (!git) {
				snap.notify("git was not found on PATH.", "error");
				return;
			}

			const { cwd, sessionSignal: signal } = snap;
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
							snap.notify("git was not found on PATH.", "error");
							return;
						}
						snap.notify(
							result.killed
								? `${command} was interrupted or timed out. Check git status before retrying.`
								: `${command} failed (exit code ${result.code}).`,
							"error",
						);
						return;
					}
				}
				snap.notify('Committed with message "wip".', "info");
			} catch {
				snap.notify(`${command} could not be executed.`, "error");
			} finally {
				if (activeRun === run) activeRun = undefined;
			}
		},
	});
}
