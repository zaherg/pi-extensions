import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const counters = ["total_commands", "total_input", "total_output", "total_saved"] as const;
type Gain = Record<(typeof counters)[number], number>;
const gainArgs = ["gain", "--format", "json"];
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en");

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGain(value: unknown): value is Gain {
	return record(value) && counters.every((key) => {
		const n = value[key];
		return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
	});
}

function summary(value: unknown) {
	if (record(value) && validGain(value.summary) && value.summary.total_saved <= value.summary.total_input) return value.summary;
}

function sandboxes(value: unknown) {
	if (value === null) return new Map<string, string>();
	if (!Array.isArray(value)) return;
	const names = new Map<string, string>();
	for (const box of value) {
		if (!record(box) || typeof box.name !== "string" || !/^[a-z\d][a-z\d.-]{0,62}$/i.test(box.name)
			|| typeof box.status !== "string" || !box.status || names.has(box.name)) return;
		names.set(box.name, box.status);
	}
	return names;
}

function plural(count: number, word: string) {
	return `${word}${count === 1 ? "" : "s"}`;
}

function savings(gain: Gain, format = exact) {
	const percent = gain.total_input ? (gain.total_saved / gain.total_input) * 100 : 0;
	return `${format.format(gain.total_saved)} ${plural(gain.total_saved, "token")} saved (${percent.toFixed(1)}%)`;
}

function detail(name: string, gain: Gain) {
	return `${name}: ${savings(gain)}\n  ${exact.format(gain.total_commands)} ${plural(gain.total_commands, "command")} | ${exact.format(gain.total_input)} tokens before / ${exact.format(gain.total_output)} after`;
}

function guestExit(code: number) {
	if (code === 127) return "rtk not found in sandbox";
	if (code === 125) return "sbx could not run rtk";
	return `rtk exited with code ${code}`;
}

function formatAll(rows: [string, Gain | string][], noSandboxes: boolean): [string, "info" | "warning" | "error"] {
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
	if (!validGain(total)) return [["Total unavailable: counters exceed safe integer range.", ...lines].join("\n"), "warning"];
	const complete = reported === rows.length;
	return [[detail(complete ? "Total" : "Total (reported only)", total), ...lines].join("\n"), complete ? "info" : "warning"];
}

export default function rtkGain(pi: ExtensionAPI) {
	const lifetime = new AbortController();
	const { signal } = lifetime;

	async function query<T>(
		cwd: string,
		command: string,
		args: string[],
		parse: (json: unknown) => T | undefined,
		onExit?: (code: number) => string,
	): Promise<T | string> {
		let result: ExecResult;
		try {
			result = await pi.exec(command, args, { cwd, signal, timeout: 5_000, maxBuffer: 1024 * 1024 });
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
		const { cwd } = ctx;
		const next = query(cwd, "rtk", gainArgs, summary).then((gain) => {
			try {
				if (!signal.aborted && ctx.hasUI) {
					ctx.ui.setStatus("rtk-gain", typeof gain === "string" ? undefined : `RTK: ${savings(gain, compact)}`);
				}
			} finally {
				pending = undefined;
				const follow = queued;
				queued = undefined;
				if (follow && !signal.aborted) void readLocal(follow);
			}
			return gain;
		});
		pending = next;
		return next;
	}

	function refresh(ctx: ExtensionContext) {
		if (signal.aborted || !ctx.hasUI) return;
		if (pending) queued = ctx;
		else void readLocal(ctx);
	}

	async function freshLocal(ctx: ExtensionContext): Promise<Gain | string> {
		// Wait for any in-flight background read so commands never return a pre-command snapshot.
		queued = undefined;
		while (pending) await pending;
		return signal.aborted ? "rtk was interrupted or timed out" : readLocal(ctx);
	}

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("turn_end", (event, ctx) => {
		if (event.toolResults.length > 0) refresh(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => refresh(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		lifetime.abort();
		queued = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("rtk-gain", undefined);
		await pending;
	});

	pi.registerCommand("rtk-gain", {
		description: "Show RTK token savings here, or across the host and running Docker sandboxes: /rtk-gain [all]",
		handler: async (args, ctx) => {
			const { cwd } = ctx;
			const show = (text: string, level: "info" | "warning" | "error") => {
				if (signal.aborted) return;
				if (ctx.hasUI) ctx.ui.notify(text, level);
				else process.stderr.write(`${text}\n`);
			};
			const scope = args.trim();
			if (scope && scope !== "all") return show("Usage: /rtk-gain [all]", "error");
			const here = await freshLocal(ctx);
			if (!scope) {
				return typeof here === "string"
					? show(`Local RTK gain unavailable: ${here}. Check rtk gain --format json.`, "error")
					: show(detail("Local RTK gain", here), "info");
			}
			if (signal.aborted) return;
			const rows: [string, Gain | string][] = [["Local", here]];
			const boxes = await query(cwd, "sbx", ["--no-input", "ls", "--json"], sandboxes);
			if (signal.aborted) return;
			if (typeof boxes === "string") {
				rows.push(["Sandboxes", `${boxes}; check sbx ls --json on the host`]);
			} else if (boxes.size > 0) {
				rows.push(...await Promise.all([...boxes].map(async ([name, status]): Promise<[string, Gain | string]> => {
					const label = `Sandbox ${name}`;
					if (status !== "running") return [label, status === "stopped" ? "stopped" : "not running"];
					// shortcut: sbx exec can start a guest stopped since listing, use a no-start exec flag if sbx adds one.
					return [label, await query(cwd, "sbx", ["--no-input", "exec", "--", name, "rtk", ...gainArgs], summary, guestExit)];
				})));
			}

			const [text, level] = formatAll(rows, boxes instanceof Map && boxes.size === 0);
			show(text, level);
		},
	});
}
