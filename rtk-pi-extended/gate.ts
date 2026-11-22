import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canCapListing, type Pipeline } from "./policy.ts";

// Thresholds matching RTK 1.2's cap and dedup methods.
const CAP_LINES = 300;
const CAP_HEAD_LINES = 50;
const CAP_TAIL_LINES = 200;
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

export function exceedsCap(text: string): boolean {
	const lines = text.split("\n");
	return (
		lines.length > CAP_LINES ||
		lines.some((line: string) => line.length > CAP_LINE_CHARS)
	);
}

type Trigger = (text: string) => boolean;

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

export type ParsedRule =
	| { kind: "disabled" }
	| { kind: "methods"; methods: string[] }
	| { kind: "unsupported" };

export function ruleMethods(directory: string): ParsedRule {
	if (existsSync(join(directory, "pipelines"))) return { kind: "unsupported" };
	const text = readFileSync(join(directory, "pipeline.toml"), "utf8").replace(
		/^\s*#.*$/gm,
		"",
	);
	if (text.match(/^\s*\[\[/gm)?.length !== 1) return { kind: "unsupported" };
	if (!/^\s*\[\[hook\.after_tool\.any\]\]/m.test(text))
		return { kind: "unsupported" };
	if (/^\s*enabled\s*=\s*false\s*$/m.test(text)) return { kind: "disabled" };
	const use = /^\s*use\s*=\s*\[([^\]]*)\]/m.exec(text)?.[1];
	if (use === undefined) return { kind: "unsupported" };
	const names = [...use.matchAll(/"([^"]+)"/g)].map(
		(match: RegExpExecArray) => match[1] ?? "",
	);
	const methods = names.flatMap((name: string) => CHAINS[name] ?? [name]);
	return methods.every((name: string) => name in TRIGGERS)
		? { kind: "methods", methods }
		: { kind: "unsupported" };
}

export function createGate(root: string): Gate {
	const cache = new Map<Pipeline, { mtime: number; rule: ParsedRule }>();
	return (profile: Pipeline, text: string): boolean => {
		const directory = join(root, profile);
		let rule: ParsedRule;
		try {
			const mtime = statSync(join(directory, "pipeline.toml")).mtimeMs;
			const cached = cache.get(profile);
			if (cached?.mtime === mtime) rule = cached.rule;
			else {
				rule = ruleMethods(directory);
				cache.set(profile, { mtime, rule });
			}
		} catch {
			return true;
		}
		if (rule.kind === "disabled") return false;
		if (
			profile === "listing" &&
			(rule.kind === "unsupported" || rule.methods.includes("cap")) &&
			!canCapListing(text, CAP_HEAD_LINES, CAP_TAIL_LINES, CAP_LINES)
		) {
			return false;
		}
		if (rule.kind === "unsupported") return true;
		return rule.methods.some((name: string) => TRIGGERS[name]?.(text) ?? true);
	};
}
