import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// RTK 1.2 method thresholds (engine/src/methods): `cap` windows outputs over
// 300 lines and lines over 2,000 characters; `dedup` collapses runs of three.
const CAP_LINES = 300;
const CAP_LINE_CHARS = 2_000;
const DEDUP_RUN = 3;
const BASE64_RUN = /[A-Za-z0-9+/]{1024,}/;

function hasRepeatedRun(text: string): boolean {
	let previous: string | undefined;
	let run = 0;
	for (const line of text.split("\n")) {
		run = line === previous && line.trim() !== "" ? run + 1 : 1;
		if (run >= DEDUP_RUN) return true;
		previous = line;
	}
	return false;
}

function exceedsCap(text: string): boolean {
	const lines = text.split("\n");
	return (
		lines.length > CAP_LINES ||
		lines.some((line) => line.length > CAP_LINE_CHARS)
	);
}

type Trigger = (text: string) => boolean;

/** Conservative: `true` whenever the method might change the text. */
const TRIGGERS: Record<string, Trigger> = {
	ansi: (text) => text.includes("\u001b"),
	progress: (text) => text.includes("\r"),
	dedup: hasRepeatedRun,
	"base64-elide": (text) => BASE64_RUN.test(text),
	cap: exceedsCap,
};
const CHAINS: Record<string, string[]> = {
	term: ["ansi", "progress", "dedup", "base64-elide", "cap"],
};

/**
 * Methods of the profile's single bundled rule, `[]` when it is disabled, or
 * `undefined` when the configuration has a shape this gate does not model.
 */
export function ruleMethods(directory: string): string[] | undefined {
	if (existsSync(join(directory, "pipelines"))) return undefined;
	const text = readFileSync(join(directory, "pipeline.toml"), "utf8").replace(
		/^\s*#.*$/gm,
		"",
	);
	if (text.match(/^\s*\[\[/gm)?.length !== 1) return undefined;
	if (!/^\s*\[\[hook\.after_tool\.any\]\]/m.test(text)) return undefined;
	if (/^\s*enabled\s*=\s*false\s*$/m.test(text)) return [];
	const use = /^\s*use\s*=\s*\[([^\]]*)\]/m.exec(text)?.[1];
	if (use === undefined) return undefined;
	const names = [...use.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
	const methods = names.flatMap((name) => CHAINS[name] ?? [name]);
	return methods.every((name) => name in TRIGGERS) ? methods : undefined;
}

/**
 * Decides, without starting RTK, whether a profile's rule could change a
 * text. Rule files are re-read when they change on disk.
 */
export function createGate(root: string) {
	const cache = new Map<string, { mtime: number; methods?: string[] }>();
	return (profile: string, text: string): boolean => {
		const directory = join(root, profile);
		let methods: string[] | undefined;
		try {
			const mtime = statSync(join(directory, "pipeline.toml")).mtimeMs;
			const cached = cache.get(profile);
			if (cached?.mtime === mtime) methods = cached.methods;
			else {
				methods = ruleMethods(directory);
				cache.set(profile, { mtime, ...(methods ? { methods } : {}) });
			}
		} catch {
			// RTK reports configuration problems itself; let it run.
			return true;
		}
		if (methods === undefined) return true;
		return methods.some((name) => TRIGGERS[name]?.(text) ?? true);
	};
}
