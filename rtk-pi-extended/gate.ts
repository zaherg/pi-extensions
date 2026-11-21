import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Pipeline } from "./policy.ts";

// Thresholds matching RTK 1.2's cap and dedup methods.
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
		lines.some((line: string) => line.length > CAP_LINE_CHARS)
	);
}

type Trigger = (text: string) => boolean;

/** Conservative predicates returning true whenever a method might change text. */
const TRIGGERS: Record<string, Trigger> = {
	ansi: (text: string): boolean => text.includes("\u001b"),
	progress: (text: string): boolean => text.includes("\r"),
	dedup: hasRepeatedRun,
	"base64-elide": (text: string): boolean => BASE64_RUN.test(text),
	cap: exceedsCap,
};
const CHAINS: Record<string, string[]> = {
	term: ["ansi", "progress", "dedup", "base64-elide", "cap"],
};

export type Gate = (profile: Pipeline, text: string) => boolean;

/** Parse active method names from a bundled pipeline rule, or undefined when unsupported. */
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
	const names = [...use.matchAll(/"([^"]+)"/g)].map(
		(match: RegExpExecArray) => match[1] ?? "",
	);
	const methods = names.flatMap((name: string) => CHAINS[name] ?? [name]);
	return methods.every((name: string) => name in TRIGGERS) ? methods : undefined;
}

/** Check whether a profile's cached pipeline rule could modify text without spawning RTK. */
export function createGate(root: string): Gate {
	const cache = new Map<Pipeline, { mtime: number; methods?: string[] }>();
	return (profile: Pipeline, text: string): boolean => {
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
			// Fall back to running RTK when the pipeline file cannot be inspected.
			return true;
		}
		if (methods === undefined) return true;
		return methods.some((name: string) => TRIGGERS[name]?.(text) ?? true);
	};
}
