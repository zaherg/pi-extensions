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
	if (!Array.isArray(value)) return;
	const names = new Map<string, string>();
	for (const box of value) {
		if (!record(box) || typeof box.name !== "string" || !/^[a-z\d][a-z\d.-]{0,62}$/i.test(box.name)
			|| typeof box.status !== "string" || !box.status || names.has(box.name)) return;
		names.set(box.name, box.status);
	}
	return names;
}

function savings(gain: Gain, format = exact) {
	const percent = gain.total_input ? (gain.total_saved / gain.total_input) * 100 : 0;
	return `${format.format(gain.total_saved)} tokens saved (${percent.toFixed(1)}%)`;
}

function detail(name: string, gain: Gain) {
	return `${name}: ${savings(gain)}\n  ${exact.format(gain.total_commands)} commands | ${exact.format(gain.total_input)} tokens before / ${exact.format(gain.total_output)} after`;
}

export default function rtkGain(pi: ExtensionAPI) {
	const lifetime = new AbortController();
	const { signal } = lifetime;

	async function query<T>(cwd: string, command: string, args: string[], parse: (json: unknown) => T | undefined): Promise<T | string> {
		let result: ExecResult;
		try {
			result = await pi.exec(command, args, { cwd, signal, timeout: 5_000, maxBuffer: 1024 * 1024 });
		} catch {
			return `could not run ${command}`;
		}
		if (result.truncated) return `${command} output exceeded 1 MiB`;
		if (result.killed) return `${command} was interrupted or timed out`;
		if (result.code !== 0) return `${command} exited with code ${result.code}`;
		let json: unknown;
		try {
			json = JSON.parse(result.stdout);
		} catch {
			return `${command} returned invalid JSON`;
		}
		return parse(json) ?? `${command} returned an unexpected report format`;
	}

	let pending: Promise<Gain | string> | undefined;
	function local(ctx: ExtensionContext) {
		pending ??= query(ctx.cwd, "rtk", gainArgs, summary).then((gain) => {
			if (ctx.hasUI && !signal.aborted) {
				ctx.ui.setStatus("rtk-gain", typeof gain === "string" ? undefined : `RTK: ${savings(gain, compact)}`);
			}
			return gain;
		}).finally(() => { pending = undefined; });
		return pending;
	}

	function refresh(_event: unknown, ctx: ExtensionContext) {
		if (ctx.hasUI) void local(ctx);
	}
	pi.on("session_start", refresh);
	pi.on("agent_settled", refresh);
	pi.on("session_shutdown", async (_event, ctx) => {
		lifetime.abort();
		if (ctx.hasUI) ctx.ui.setStatus("rtk-gain", undefined);
		await pending;
	});

	pi.registerCommand("rtk-gain", {
		description: "Show RTK token savings here, or across the host and running Docker sandboxes: /rtk-gain [all]",
		handler: async (args, ctx) => {
			const show = (text: string, level: "info" | "warning" | "error") => {
				if (signal.aborted) return;
				if (ctx.hasUI) ctx.ui.notify(text, level);
				else process.stderr.write(`${text}\n`);
			};
			const scope = args.trim();
			if (scope && scope !== "all") return show("Usage: /rtk-gain [all]", "error");
			const here = await local(ctx);
			if (!scope) {
				return typeof here === "string"
					? show(`Local RTK gain unavailable: ${here}. Check rtk gain --format json.`, "error")
					: show(detail("Local RTK gain", here), "info");
			}
			if (signal.aborted) return;
			const rows: [string, Gain | string][] = [["Local", here]];
			const boxes = await query(ctx.cwd, "sbx", ["--no-input", "ls", "--json"], sandboxes);
			if (typeof boxes === "string") {
				rows.push(["Sandboxes", `${boxes}; check sbx ls --json on the host`]);
			} else {
				for (const [name, status] of boxes) {
					if (signal.aborted) return;
					const label = `Sandbox ${name}`;
					if (status !== "running") {
						rows.push([label, status === "stopped" ? "stopped" : "not running"]);
						continue;
					}
					// shortcut: sbx exec can start a guest stopped since listing, use a no-start exec flag if sbx adds one.
					rows.push([label, await query(ctx.cwd, "sbx", ["--no-input", "exec", "--", name, "rtk", ...gainArgs], summary)]);
				}
			}

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
			if (!reported) return show(["No RTK gains available.", ...lines].join("\n"), "error");
			if (!validGain(total)) return show(["Total unavailable: counters exceed safe integer range.", ...lines].join("\n"), "warning");
			show([detail("Total (reported only)", total), ...lines].join("\n"), reported === rows.length ? "info" : "warning");
		},
	});
}
