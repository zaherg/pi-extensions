import type {
	AgentSettledEvent,
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveExecutable } from "../shared/executable.ts";

const counters = ["total_commands", "total_input", "total_output", "total_saved"] as const;
type CounterKey = (typeof counters)[number];
type Gain = Record<CounterKey, number>;
type NotifyLevel = NonNullable<Parameters<ExtensionUIContext["notify"]>[1]>;

const gainArgs = ["gain", "--format", "json"];
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en");

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGain(value: unknown): value is Gain {
	return (
		record(value) &&
		counters.every((key: CounterKey) => {
			const n = value[key];
			return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
		})
	);
}

function summary(value: unknown): Gain | undefined {
	if (record(value) && validGain(value.summary) && value.summary.total_saved <= value.summary.total_input) {
		return value.summary;
	}
	return undefined;
}

function sandboxes(value: unknown): Map<string, string> | undefined {
	if (value === null) return new Map<string, string>();
	if (!Array.isArray(value)) return undefined;
	const names = new Map<string, string>();
	for (const box of value) {
		if (
			!record(box) ||
			typeof box.name !== "string" ||
			!/^[a-z\d][a-z\d.-]{0,62}$/i.test(box.name) ||
			typeof box.status !== "string" ||
			!box.status ||
			names.has(box.name)
		) {
			return undefined;
		}
		names.set(box.name, box.status);
	}
	return names;
}

function plural(count: number, word: string): string {
	return `${word}${count === 1 ? "" : "s"}`;
}

function savings(gain: Gain, format: Intl.NumberFormat = exact): string {
	const percent = gain.total_input ? (gain.total_saved / gain.total_input) * 100 : 0;
	return `${format.format(gain.total_saved)} ${plural(gain.total_saved, "token")} saved (${percent.toFixed(1)}%)`;
}

function detail(name: string, gain: Gain): string {
	return `${name}: ${savings(gain)}\n  ${exact.format(gain.total_commands)} ${plural(gain.total_commands, "command")} | ${exact.format(gain.total_input)} tokens before / ${exact.format(gain.total_output)} after`;
}

function guestExit(code: number): string {
	if (code === 127) return "rtk not found in sandbox";
	if (code === 125) return "sbx could not run rtk";
	return `rtk exited with code ${code}`;
}

function formatAll(rows: [string, Gain | string][], noSandboxes: boolean): [string, NotifyLevel] {
	const total: Gain = { total_commands: 0, total_input: 0, total_output: 0, total_saved: 0 };
	const lines: string[] = [];
	let reported = 0;
	for (const [name, gain] of rows) {
		if (typeof gain === "string") lines.push(`${name}: excluded (${gain})`);
		else {
			reported++;
			for (const key of counters) total[key] += gain[key];
			lines.push(detail(name, gain));
		}
	}
	if (noSandboxes) lines.push("Sandboxes: none");
	if (!reported) return [["No RTK gains available.", ...lines].join("\n"), "error"];
	if (noSandboxes) return [lines.join("\n"), "info"];
	if (!validGain(total))
		return [["Total unavailable: counters exceed safe integer range.", ...lines].join("\n"), "warning"];
	const complete = reported === rows.length;
	return [
		[detail(complete ? "Total" : "Total (reported only)", total), ...lines].join("\n"),
		complete ? "info" : "warning",
	];
}

export default function rtkGain(pi: ExtensionAPI): void {
	let lifetime = new AbortController();

	async function query<T>(
		cwd: string,
		command: string,
		args: string[],
		parse: (json: unknown) => T | undefined,
		onExit?: (code: number) => string,
	): Promise<T | string> {
		const signal = lifetime.signal;
		// Resolve bare executables from PATH so Windows never runs binaries from cwd.
		const executable = resolveExecutable(command);
		if (!executable) return `${command} not found`;
		let result: ExecResult;
		try {
			result = await pi.exec(executable, args, { cwd, signal, timeout: 5_000, maxBuffer: 1024 * 1024 });
		} catch {
			return `could not run ${command}`;
		}
		if (result.truncated) return `${command} output exceeded 1 MiB`;
		if (result.killed) return `${command} was interrupted or timed out`;
		if (result.code !== 0) {
			if (!result.stdout && /^spawn\b.*\bENOENT\b/.test(result.stderr)) return `${command} not found`;
			return onExit ? onExit(result.code) : `${command} exited with code ${result.code}`;
		}
		let json: unknown;
		try {
			json = JSON.parse(result.stdout);
		} catch {
			return `${command} returned invalid JSON`;
		}
		return parse(json) ?? `${command} returned an unexpected report format`;
	}

	let pending: Promise<Gain | string> | undefined;
	let queued: ExtensionContext | undefined;

	function readLocal(ctx: ExtensionContext): Promise<Gain | string> {
		const signal = lifetime.signal;
		const { cwd } = ctx;
		const next = query(cwd, "rtk", gainArgs, summary).then((gain: Gain | string): Gain | string => {
			try {
				if (!signal.aborted) {
					try {
						if (ctx.hasUI) {
							ctx.ui.setStatus("rtk-gain", typeof gain === "string" ? undefined : `RTK: ${savings(gain, compact)}`);
						}
					} catch {
						// Ignore stale ExtensionContext getters if the session was replaced or disposed mid-query.
					}
				}
			} finally {
				if (pending === next) pending = undefined;
				const follow = queued;
				queued = undefined;
				if (follow && !lifetime.signal.aborted) {
					try {
						void readLocal(follow);
					} catch {
						// Ignore stale queued context after session replacement or disposal.
					}
				}
			}
			return gain;
		});
		pending = next;
		return next;
	}

	function refresh(ctx: ExtensionContext): void {
		const signal = lifetime.signal;
		if (signal.aborted || !ctx.hasUI) return;
		if (pending) queued = ctx;
		else void readLocal(ctx);
	}

	async function freshLocal(ctx: ExtensionContext): Promise<Gain | string> {
		const signal = lifetime.signal;
		// Wait for any in-flight background read so commands never return stale data.
		queued = undefined;
		while (pending) await pending;
		return signal.aborted ? "rtk was interrupted or timed out" : readLocal(ctx);
	}

	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext): void => {
		lifetime.abort();
		lifetime = new AbortController();
		refresh(ctx);
	});
	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext): undefined => {
		if (event.toolResults.length > 0) refresh(ctx);
		return undefined;
	});
	pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext): void => refresh(ctx));
	pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> => {
		lifetime.abort();
		queued = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("rtk-gain", undefined);
		await pending;
	});

	pi.registerCommand("rtk-gain", {
		description: "Show RTK token savings here, or across the host and running Docker sandboxes: /rtk-gain [all]",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const signal = lifetime.signal;
			const { cwd } = ctx;
			const show = (text: string, level: NotifyLevel): void => {
				if (signal.aborted) return;
				try {
					if (ctx.hasUI) {
						ctx.ui.notify(text, level);
						return;
					}
				} catch {
					// Fall back to stderr if the session context became stale.
				}
				process.stderr.write(`${text}\n`);
			};
			const scope = args.trim();
			if (scope && scope !== "all") {
				show("Usage: /rtk-gain [all]", "error");
				return;
			}
			const here = await freshLocal(ctx);
			if (!scope) {
				if (typeof here === "string") {
					show(`Local RTK gain unavailable: ${here}. Check rtk gain --format json.`, "error");
				} else {
					show(detail("Local RTK gain", here), "info");
				}
				return;
			}
			if (signal.aborted) return;
			const rows: [string, Gain | string][] = [["Local", here]];
			const boxes = await query(cwd, "sbx", ["--no-input", "ls", "--json"], sandboxes);
			if (signal.aborted) return;
			if (typeof boxes === "string") {
				rows.push(["Sandboxes", `${boxes}; check sbx ls --json on the host`]);
			} else if (boxes.size > 0) {
				rows.push(
					...(await Promise.all(
						[...boxes].map(async ([name, status]: [string, string]): Promise<[string, Gain | string]> => {
							const label = `Sandbox ${name}`;
							if (status !== "running") return [label, status === "stopped" ? "stopped" : "not running"];
							// Skip stopped sandboxes because sbx exec can start guests lacking a no-start flag.
							return [
								label,
								await query(
									cwd,
									"sbx",
									["--no-input", "exec", "--", name, "rtk", ...gainArgs],
									summary,
									guestExit,
								),
							];
						}),
					)),
				);
			}

			const [text, level] = formatAll(rows, boxes instanceof Map && boxes.size === 0);
			show(text, level);
		},
	});
}
