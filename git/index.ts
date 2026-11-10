import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	CAPTURE_BYTES,
	gitResultMessage,
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

	// Custom entries render in the transcript without becoming model context.
	pi.registerEntryRenderer<string>("git-output", (entry, _options, theme) => {
		const message =
			typeof entry.data === "string" ? entry.data : "Invalid saved Git output.";
		return new Text(`${theme.fg("accent", "/git")}\n${message}`, 1, 0);
	});

	pi.registerCommand("git", {
		description:
			'Run any Git command with inline results; commit "message" means commit -m "message"',
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
			// Ctrl+C must not terminate Pi during terminal handoff.
			const ignoreSigint = () => {};
			process.on("SIGINT", ignoreSigint);
			let message: string;
			try {
				const result = await ctx.ui.custom<SpawnSyncReturns<Buffer>>(
					(tui, _theme, _keybindings, done) => {
						let result: SpawnSyncReturns<Buffer>;
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
						} finally {
							tui.start();
							tui.requestRender(true);
						}
						done(result);
						return { render: () => [], invalidate() {} };
					},
				);

				message = result.error
					? "Git shell could not be started. Check SHELL and the project directory."
					: gitResultMessage(result.stdout, result.status, result.signal);
			} catch {
				// Shell errors can contain credentials; never copy them into Pi's transcript.
				message =
					"Git terminal execution failed. Check git status before retrying.";
			} finally {
				// spawnSync defers signals. Two check phases allow an intervening poll
				// before restoring the default handler, even when invoked from I/O.
				await setImmediate();
				await setImmediate();
				process.removeListener("SIGINT", ignoreSigint);
				running = false;
			}

			try {
				pi.appendEntry("git-output", message);
			} catch {
				// A persistence error must not misreport execution or cause a retry.
				ctx.ui.notify(
					`Could not save Git's inline result.\n${message}`,
					"warning",
				);
			}
		},
	});
}
