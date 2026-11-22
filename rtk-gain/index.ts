import type {
	AgentSettledEvent,
	ExecResult,
	ExtensionAPI,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveExecutable } from "../shared/executable.ts";
import {
	bindSession,
	type NotifyLevel,
	type SessionSnapshot,
} from "../shared/session.ts";

const counters = [
	"total_commands",
	"total_input",
	"total_output",
	"total_saved",
] as const;
type CounterKey = (typeof counters)[number];
type Gain = Record<CounterKey, number>;

const gainArgs = ["gain", "--format", "json"];
const MAX_SANDBOX_CONCURRENCY = 8;
const compact = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const exact = new Intl.NumberFormat("en");

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const runners = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await worker(items[index] as T);
			}
		},
	);
	await Promise.all(runners);
	return results;
}

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
	if (
		record(value) &&
		validGain(value.summary) &&
		value.summary.total_saved <= value.summary.total_input
	) {
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
	const percent = gain.total_input
		? (gain.total_saved / gain.total_input) * 100
		: 0;
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

function formatAll(
	rows: [string, Gain | string][],
	noSandboxes: boolean,
): [string, NotifyLevel] {
	const total: Gain = {
		total_commands: 0,
		total_input: 0,
		total_output: 0,
		total_saved: 0,
	};
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
	if (!reported)
		return [["No RTK gains available.", ...lines].join("\n"), "error"];
	if (noSandboxes) return [lines.join("\n"), "info"];
	if (!validGain(total))
		return [
			["Total unavailable: counters exceed safe integer range.", ...lines].join(
				"\n",
			),
			"warning",
		];
	const complete = reported === rows.length;
	return [
		[
			detail(complete ? "Total" : "Total (reported only)", total),
			...lines,
		].join("\n"),
		complete ? "info" : "warning",
	];
}

export default function rtkGain(pi: ExtensionAPI): void {
	const session = bindSession(pi);

	async function query<T>(
		cwd: string,
		signal: AbortSignal,
		command: string,
		args: string[],
		parse: (json: unknown) => T | undefined,
		onExit?: (code: number) => string,
	): Promise<T | string> {
		const executable = resolveExecutable(command);
		if (!executable) return `${command} not found`;
		let result: ExecResult;
		try {
			result = await pi.exec(executable, args, {
				cwd,
				signal,
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
			});
		} catch {
			return `could not run ${command}`;
		}
		if (result.truncated) return `${command} output exceeded 1 MiB`;
		if (result.killed) return `${command} was interrupted or timed out`;
		if (result.code !== 0) {
			if (!result.stdout && /^spawn\b.*\bENOENT\b/.test(result.stderr))
				return `${command} not found`;
			return onExit
				? onExit(result.code)
				: `${command} exited with code ${result.code}`;
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
	let queued: SessionSnapshot | undefined;

	function readLocal(snap: SessionSnapshot): Promise<Gain | string> {
		const { cwd, sessionSignal: signal } = snap;
		const next = query(cwd, signal, "rtk", gainArgs, summary).then(
			(gain: Gain | string): Gain | string => {
				try {
					if (!signal.aborted) {
						snap.setStatus(
							"rtk-gain",
							typeof gain === "string"
								? undefined
								: `RTK: ${savings(gain, compact)}`,
						);
					}
				} finally {
					if (pending === next) pending = undefined;
					const follow = queued;
					queued = undefined;
					if (follow && !follow.sessionSignal.aborted) {
						void readLocal(follow);
					}
				}
				return gain;
			},
		);
		pending = next;
		return next;
	}

	function refresh(snap: SessionSnapshot): void {
		if (snap.sessionSignal.aborted || !snap.hasUI) return;
		if (pending) queued = snap;
		else void readLocal(snap);
	}

	async function freshLocal(snap: SessionSnapshot): Promise<Gain | string> {
		const { sessionSignal: signal } = snap;
		queued = undefined;
		while (pending) await pending;
		return signal.aborted
			? "rtk was interrupted or timed out"
			: readLocal(snap);
	}

	session.onLifecycle(
		"session_start",
		(_event: SessionStartEvent, snap: SessionSnapshot | undefined): void => {
			queued = undefined;
			if (snap) refresh(snap);
		},
	);
	session.on(
		"turn_end",
		(event: TurnEndEvent, snap: SessionSnapshot): undefined => {
			if (event.toolResults.length > 0) refresh(snap);
			return undefined;
		},
	);
	session.on(
		"agent_settled",
		(_event: AgentSettledEvent, snap: SessionSnapshot): void => refresh(snap),
	);
	session.onLifecycle(
		"session_shutdown",
		async (
			_event: SessionShutdownEvent,
			snap: SessionSnapshot | undefined,
		): Promise<void> => {
			queued = undefined;
			snap?.setStatus("rtk-gain", undefined);
			await pending;
		},
	);

	session.registerCommand("rtk-gain", {
		description:
			"Show RTK token savings here, or across the host and running Docker sandboxes: /rtk-gain [all]",
		handler: async (args: string, snap: SessionSnapshot): Promise<void> => {
			const { cwd, sessionSignal: signal } = snap;
			const show = (text: string, level: NotifyLevel): void => {
				snap.notify(text, level, { stderr: true });
			};
			const scope = args.trim();
			if (scope && scope !== "all") {
				show("Usage: /rtk-gain [all]", "error");
				return;
			}
			const here = await freshLocal(snap);
			if (!scope) {
				if (typeof here === "string") {
					show(
						`Local RTK gain unavailable: ${here}. Check rtk gain --format json.`,
						"error",
					);
				} else {
					show(detail("Local RTK gain", here), "info");
				}
				return;
			}
			if (signal.aborted) return;
			const rows: [string, Gain | string][] = [["Local", here]];
			const boxes = await query(
				cwd,
				signal,
				"sbx",
				["--no-input", "ls", "--json"],
				sandboxes,
			);
			if (signal.aborted) return;
			if (typeof boxes === "string") {
				rows.push(["Sandboxes", `${boxes}; check sbx ls --json on the host`]);
			} else if (boxes.size > 0) {
				rows.push(
					...(await mapLimit(
						[...boxes],
						MAX_SANDBOX_CONCURRENCY,
						async ([name, status]: [string, string]): Promise<
							[string, Gain | string]
						> => {
							const label = `Sandbox ${name}`;
							// Skip stopped sandboxes because sbx exec can start guests lacking a no-start flag.
							if (status !== "running")
								return [
									label,
									status === "stopped" ? "stopped" : "not running",
								];
							return [
								label,
								await query(
									cwd,
									signal,
									"sbx",
									["--no-input", "exec", "--", name, "rtk", ...gainArgs],
									summary,
									guestExit,
								),
							];
						},
					)),
				);
			}

			const [text, level] = formatAll(
				rows,
				boxes instanceof Map && boxes.size === 0,
			);
			show(text, level);
		},
	});
}
