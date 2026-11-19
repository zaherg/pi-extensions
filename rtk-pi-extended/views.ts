import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/** Pi `read` continuation notice, appended after a blank line. */
const READ_NOTICE =
	/\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^)\n]*\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\])$/;

/** File lines a `read` result shows, split from Pi's continuation notice. */
export interface ReadView {
	/** 1-based line number of the first body line. */
	start: number;
	body: string;
	lines: string[];
	notice?: string;
}

/**
 * `text` is Pi's raw `read` output; `offset` is the call's effective input.
 * Messages Pi returns instead of file lines (such as an oversized first line)
 * have no line view.
 */
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

/** Pi `bash` truncation notice on successful output, appended after a blank line. */
const BASH_TRAILER = /\n\n(\[Showing [^\n]*\. Full output: [^\n]+\])$/;

/**
 * Splits a successful Bash file view into the printed text and Pi's trailing
 * truncation notice, which a condensed view must keep verbatim.
 */
export function splitBashTrailer(text: string): {
	body: string;
	trailer?: string;
} {
	const match = BASH_TRAILER.exec(text);
	if (!match?.[1]) return { body: text };
	return { body: text.slice(0, match.index), trailer: match[1] };
}

/** Mirrors Pi's `resolveToCwd` for keys; a mismatch only prevents deduplication. */
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

/** Only non-code classes are condensed; everything else stays byte-exact. */
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

type Extract = (line: string, state: { name?: string }) => string | undefined;

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

const npm: Extract = (line, state) => {
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

/** `name = "x"` followed by `version = "y"` in Cargo, Poetry, and uv lockfiles. */
const tomlPackages: Extract = (line, state) => {
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

const composer: Extract = (line, state) => {
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

const yarn: Extract = (line, state) => {
	// v1 headers start at column 0 and end with ":"; Berry prefixes ranges with a protocol.
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

const pnpm: Extract = (line) => {
	const match =
		/^ {2}\/?'?((?:@[^@/\s']+\/)?[^@\s'/]+)@([^:'\s(]+)(?:\([^\n]*\))?'?:$/.exec(
			line,
		);
	return match ? `${match[1]}@${match[2]}` : undefined;
};

const bun: Extract = (line) =>
	/^\s+"[^"]+": \["((?:@[^@/"]+\/)?[^@"]+@[^"]+)"/.exec(line)?.[1];

const gemfile: Extract = (line) => {
	const match = /^ {4}([A-Za-z0-9_.-]+) \(([^)]+)\)$/.exec(line);
	return match ? `${match[1]}@${match[2]}` : undefined;
};

const goSum: Extract = (line) => {
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

/** Unique `name@version` entries visible in a lockfile excerpt, in order. */
export function lockfilePackages(path: string, text: string): string[] {
	const extract = EXTRACTORS[basename(path)];
	if (!extract) return [];
	const state: { name?: string } = {};
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const entry = extract(line, state);
		if (entry !== undefined) seen.add(entry);
	}
	return seen.size >= MIN_PACKAGES ? [...seen] : [];
}

const LONG_LINE = 300;

/** Keeps the first 300 characters of each longer line, with an explicit marker. */
export function truncateLongLines(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			line.length > LONG_LINE
				? `${line.slice(0, LONG_LINE)}…[+${line.length - LONG_LINE} chars]`
				: line,
		)
		.join("\n");
}

/**
 * JSON strings cannot contain raw newlines, so leading whitespace on a line
 * is always insignificant, even in an excerpt that is not a whole document.
 */
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
].map((view) => new RegExp(`${CD_PREFIX}${view}\\s*$`));

function unquote(token: string): string {
	return /^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token;
}

/**
 * The file a Bash command only prints, such as `cat a.ts` or
 * `cd app && sed -n '1,80p' a.ts`; pipelines and other shapes are not views.
 */
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
