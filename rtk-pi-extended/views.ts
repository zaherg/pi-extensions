import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/** Pi read continuation notice appended after a blank line. */
const READ_NOTICE =
	/\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^)\n]*\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\])$/;

/** File lines shown by a read result, separated from Pi's continuation notice. */
export interface ReadView {
	/** 1-based line number of the first body line. */
	start: number;
	body: string;
	lines: string[];
	notice?: string;
}

/** Parse raw Pi read output into numbered lines and an optional continuation notice. */
export function parseReadView(
	text: string,
	offset: unknown,
): ReadView | undefined {
	if (text.startsWith("[Line ") && !text.includes("\n")) return undefined;
	const start =
		typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0
			? offset
			: 1;
	const match = READ_NOTICE.exec(text);
	const body = match ? text.slice(0, match.index) : text;
	return {
		start,
		body,
		lines: body.split("\n"),
		...(match?.[1] ? { notice: match[1] } : {}),
	};
}

/** Pi bash truncation and non-zero exit notices appended after a blank line. */
const BASH_TRAILER =
	/\n\n((?:\[Showing [^\n]*\. Full output: [^\n]+\])(?:\n\nCommand exited with code \d+)?|Command exited with code \d+)$/;

/** Split Bash output into body text and any trailing Pi truncation or exit notice. */
export function splitBashTrailer(text: string): {
	body: string;
	trailer?: string;
} {
	const match = BASH_TRAILER.exec(text);
	if (!match?.[1]) return { body: text };
	return { body: text.slice(0, match.index), trailer: match[1] };
}

/** Resolve a tool path argument against cwd using Pi's @ and ~ rules. */
export function resolvePath(path: string, cwd: string): string {
	let expanded = path.startsWith("@") ? path.slice(1) : path;
	if (expanded === "~" || expanded.startsWith("~/"))
		expanded = homedir() + expanded.slice(1);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export type FileClass = "lockfile" | "minified" | "log" | "json" | "text";

const LOCKFILES = new Set([
	"bun.lock",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Cargo.lock",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
	"uv.lock",
	"go.sum",
]);

/** Classify a file path so only non-code formats are condensed. */
export function fileClass(path: string): FileClass {
	const name = basename(path);
	if (LOCKFILES.has(name)) return "lockfile";
	if (
		/\.min\.(?:js|mjs|cjs|css)$/.test(name) ||
		/\.(?:js|css)\.map$/.test(name)
	)
		return "minified";
	if (/\.log(?:\.\d+)?$/.test(name)) return "log";
	if (name.endsWith(".json")) return "json";
	return "text";
}

interface ExtractState {
	name?: string | undefined;
}

type Extract = (line: string, state: ExtractState) => string | undefined;

const NPM_KEY = /^\s*"((?:[^"\\]|\\.)+)": \{$/;
const NPM_VERSION = /^\s*"version": "([^"]+)"/;
const NOT_PACKAGES = new Set([
	"",
	"packages",
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"requires",
	"engines",
	"bin",
	"funding",
	"workspaces",
]);

const npm: Extract = (
	line: string,
	state: ExtractState,
): string | undefined => {
	const key = NPM_KEY.exec(line)?.[1];
	if (key !== undefined) {
		const marker = key.lastIndexOf("node_modules/");
		const name = marker < 0 ? key : key.slice(marker + "node_modules/".length);
		state.name = NOT_PACKAGES.has(name) ? undefined : name;
		return undefined;
	}
	const version = NPM_VERSION.exec(line)?.[1];
	if (version === undefined || state.name === undefined) return undefined;
	const entry = `${state.name}@${version}`;
	state.name = undefined;
	return entry;
};

/** Extract name and version pairs from Cargo, Poetry, and uv TOML lockfiles. */
const tomlPackages: Extract = (
	line: string,
	state: ExtractState,
): string | undefined => {
	const name = /^name = "([^"]+)"$/.exec(line)?.[1];
	if (name !== undefined) {
		state.name = name;
		return undefined;
	}
	const version = /^version = "([^"]+)"$/.exec(line)?.[1];
	if (version === undefined || state.name === undefined) return undefined;
	const entry = `${state.name}@${version}`;
	state.name = undefined;
	return entry;
};

const composer: Extract = (
	line: string,
	state: ExtractState,
): string | undefined => {
	const name = /^\s*"name": "([^"]+)",$/.exec(line)?.[1];
	if (name !== undefined) {
		state.name = name;
		return undefined;
	}
	const version = /^\s*"version": "([^"]+)",?$/.exec(line)?.[1];
	if (version === undefined || state.name === undefined) return undefined;
	const entry = `${state.name}@${version}`;
	state.name = undefined;
	return entry;
};

const yarn: Extract = (
	line: string,
	state: ExtractState,
): string | undefined => {
	// Match both Yarn v1 and Berry package header lines.
	const header = /^"?((?:@[^@/"\s]+\/)?[^@"\s,]+)@[^\n]*:$/.exec(line)?.[1];
	if (header !== undefined) {
		state.name = header;
		return undefined;
	}
	const version = /^ {2}version:? "?([^"\s]+)"?$/.exec(line)?.[1];
	if (version === undefined || state.name === undefined) return undefined;
	const entry = `${state.name}@${version}`;
	state.name = undefined;
	return entry;
};

const pnpm: Extract = (line: string): string | undefined => {
	const match =
		/^ {2}\/?'?((?:@[^@/\s']+\/)?[^@\s'/]+)@([^:'\s(]+)(?:\([^\n]*\))?'?:$/.exec(
			line,
		);
	return match ? `${match[1]}@${match[2]}` : undefined;
};

const bun: Extract = (line: string): string | undefined =>
	/^\s+"[^"]+": \["((?:@[^@/"]+\/)?[^@"]+@[^"]+)"/.exec(line)?.[1];

const gemfile: Extract = (line: string): string | undefined => {
	const match = /^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/.exec(line);
	return match ? `${match[1]}@${match[2]}` : undefined;
};

const goSum: Extract = (line: string): string | undefined => {
	const match = /^(\S+) (v[^/\s]+)(?:\/go\.mod)? h1:/.exec(line);
	return match ? `${match[1]}@${match[2]}` : undefined;
};

const EXTRACTORS: Record<string, Extract> = {
	"bun.lock": bun,
	"package-lock.json": npm,
	"npm-shrinkwrap.json": npm,
	"yarn.lock": yarn,
	"pnpm-lock.yaml": pnpm,
	"Cargo.lock": tomlPackages,
	"poetry.lock": tomlPackages,
	"uv.lock": tomlPackages,
	"composer.lock": composer,
	"Gemfile.lock": gemfile,
	"go.sum": goSum,
};

const MIN_PACKAGES = 3;

/** Extract unique ordered name@version entries visible in a lockfile excerpt. */
export function lockfilePackages(path: string, text: string): string[] {
	const extract = EXTRACTORS[basename(path)];
	if (!extract) return [];
	const state: ExtractState = {};
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const entry = extract(line, state);
		if (entry !== undefined) seen.add(entry);
	}
	return seen.size >= MIN_PACKAGES ? [...seen] : [];
}

const LONG_LINE = 300;

/** Keep the first 300 characters of each long line with an explicit truncation marker. */
export function truncateLongLines(text: string): string {
	return text
		.split("\n")
		.map((line: string) =>
			line.length > LONG_LINE
				? `${line.slice(0, LONG_LINE)}…[+${line.length - LONG_LINE} chars]`
				: line,
		)
		.join("\n");
}

/** Strip leading line indentation safely from JSON text or excerpts. */
export function stripJsonIndentation(text: string): string {
	return text.replace(/^[ \t]+/gm, "");
}

const PATH_TOKEN = String.raw`('[^']+'|"[^"\\$\`]+"|[^\s'"|;&<>()$\`\\]+)`;
const CD_PREFIX = String.raw`^(?:cd\s+${PATH_TOKEN}\s*&&\s*)?`;
const VIEW_COMMANDS = [
	String.raw`cat\s+${PATH_TOKEN}`,
	String.raw`rtk\s+read\s+${PATH_TOKEN}(?:\s+--(?:head|tail)-lines\s+\d+)?`,
	String.raw`sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?\s+${PATH_TOKEN}`,
	String.raw`(?:head|tail)(?:\s+-n\s*\d+|\s+-\d+)?\s+${PATH_TOKEN}`,
	String.raw`nl(?:\s+-[A-Za-z0-9]+)*\s+${PATH_TOKEN}`,
].map((view: string) => new RegExp(`${CD_PREFIX}${view}\\s*$`));

function unquote(token: string): string {
	return /^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token;
}

/** Return the resolved file path when a Bash command only prints a single file. */
export function bashFileView(command: string, cwd: string): string | undefined {
	const trimmed = command.trim();
	for (const pattern of VIEW_COMMANDS) {
		const match = pattern.exec(trimmed);
		if (!match) continue;
		const [directory, file] = [match[1], match[2]];
		if (file === undefined) return undefined;
		const base =
			directory === undefined ? cwd : resolvePath(unquote(directory), cwd);
		return resolvePath(unquote(file), base);
	}
	return undefined;
}
