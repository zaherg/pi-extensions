import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CAPTURE_BYTES,
	gitFailureMessage,
	terminalCaptureArgs,
} from "./terminal.ts";

export function gitShellCommand(args: string): string {
	if (!args.trim()) return "git";
	// Only the standalone quoted-message shorthand differs from native Git syntax.
	const message =
		/^[ \t]*commit[ \t]+("(?:[^"\\]|\\[\s\S])*"|'[^']*')[ \t\r\n]*$/.exec(args);
	return message ? `git commit -m ${message[1]}` : `git ${args}`;
}

export default function (pi: ExtensionAPI) {
	let running = false;

	pi.registerCommand("git", {
		description:
			'Run any Git command in the shell; commit "message" means commit -m "message"',
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				throw new Error("/git requires Pi's interactive terminal.");
			}
			if (running || !ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the current operation to finish before running /git.",
					"warning",
				);
				return;
			}

			running = true;
			// Ctrl+C must not terminate Pi during terminal handoff or the return prompt.
			const ignoreSigint = () => {};
			process.on("SIGINT", ignoreSigint);
			try {
				const outcome = await ctx.ui.custom<{
					result: SpawnSyncReturns<Buffer>;
					pauseFailed: boolean;
				}>((tui, _theme, _keybindings, done) => {
					let result: SpawnSyncReturns<Buffer>;
					let pauseFailed = false;
					tui.stop();
					try {
						// This is explicitly user-authored shell source, not interpolated file data.
						// Keep cwd outside the shell source, including paths containing metacharacters.
						result = spawnSync(
							"/bin/bash",
							terminalCaptureArgs(
								process.env.SHELL || "/bin/sh",
								gitShellCommand(args),
							),
							{
								cwd: ctx.cwd,
								stdio: ["inherit", "pipe", "inherit"],
								maxBuffer: CAPTURE_BYTES + 1024,
							},
						);
						if (!result.error && !result.signal && result.status === 0) {
							// Success output remains in the terminal. Failures are replayed in Pi,
							// so they return immediately without an extra Enter prompt.
							const pause = spawnSync(
								"/bin/sh",
								[
									"-c",
									"printf '\nPress Enter to return to Pi... '; IFS= read -r reply",
								],
								{ cwd: ctx.cwd, stdio: "inherit" },
							);
							pauseFailed = Boolean(pause.error);
						}
					} finally {
						tui.start();
						tui.requestRender(true);
					}
					done({ result, pauseFailed });
					return { render: () => [], invalidate() {} };
				});

				const { result, pauseFailed } = outcome;
				if (result.error) {
					ctx.ui.notify(
						"Git shell could not be started. Check SHELL and the project directory.",
						"error",
					);
				} else if (result.signal) {
					ctx.ui.notify(
						`Git shell stopped by ${result.signal}. Check git status before retrying.`,
						"warning",
					);
				} else if (result.status !== 0) {
					ctx.ui.notify(
						gitFailureMessage(result.stdout, result.status),
						"info",
					);
				} else {
					ctx.ui.notify("Git shell completed.", "info");
				}
				if (pauseFailed)
					ctx.ui.notify(
						"The return-to-Pi prompt could not be started.",
						"warning",
					);
			} catch {
				// Shell errors can contain credentials; never copy them into Pi's transcript.
				ctx.ui.notify(
					"Git terminal execution failed. Check git status before retrying.",
					"error",
				);
			} finally {
				// spawnSync defers signals. Two check phases allow an intervening poll
				// before restoring the default handler, even when invoked from I/O.
				await setImmediate();
				await setImmediate();
				process.removeListener("SIGINT", ignoreSigint);
				running = false;
			}
		},
	});
}
