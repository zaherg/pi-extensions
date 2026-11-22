import { Buffer } from "node:buffer";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	preservesBoundaries,
	RECALL_HINT,
	type StructureCheck,
} from "./bridge.ts";
import { bashFileView, resolvePath } from "./views.ts";

/** Filtering category assigned to a tool result. */
export type Category = "read" | "terminal" | "listing" | "generic";

/** Bundled RTK profile directories under `rtk/`. */
export type Pipeline = "terminal" | "listing" | "generic";

/** Minimum UTF-8 byte size before a tool result is considered for filtering. */
export const MIN_BYTES = 512;

const EXCLUDED = new Set(["edit", "write"]);
// Match Pi's built-in search tools and FFF's tool names in both registration modes.
const LISTING = new Set([
	"grep",
	"find",
	"ls",
	"ffgrep",
	"fffind",
	"fff-multi-grep",
	"multi_grep",
]);
export const SHELL_SETUP = new Set([
	"cd",
	"set",
	"export",
	"unset",
	"umask",
	"pushd",
	"popd",
	"shopt",
	"source",
	".",
	"trap",
	"true",
	":",
]);
export const SHELL_PREFIX = new Set([
	"env",
	"time",
	"command",
	"exec",
	"nohup",
	"nice",
]);
export const SHELL_PREFIX_FLAGS_WITH_ARG: Readonly<
	Record<string, ReadonlySet<string>>
> = {
	env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
	nice: new Set(["-n", "--adjustment"]),
	exec: new Set(["-a"]),
};
const UNFILTERED_RTK_SUBCOMMANDS = new Set([
	"read",
	"bypass",
	"proxy",
	"run",
	"recall",
]);
const SAFE_PROGRAM_NAME = /^(?:[A-Za-z0-9._+-]+|:)$/;
// Match pi-lens's read-widening banner prepended ahead of the file body block.
const PI_LENS_WIDENED =
	/^\[pi-lens: read widened [\s\S]*?\bthis shows lines (\d+)-\d+\b/;
const NUMBERED_LINE = /^ \d+[:-] /;
const FULL_OUTPUT_NOTICE = /^\[.*Full output: .*\]$/;
const ANSI_ESCAPE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the match target.
	/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const DEDUP_COUNT = /^\[x(\d+)\]$/;
const MIN_DEDUP_RUN = 3;
const LONG_LINE_CAP = /^([\s\S]*) \[\+(\d+) chars\]$/;
const BASE64_ELIDED =
	/(?:\[base64 (?:data|[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+), [^\]]+ elided\])+/g;
const BASE64_MARKER_OPEN = "[base64 ";
const DATA_URL_HEADER = /^data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,/;
const MIN_BASE64_RUN = 1_024;

export interface Route {
	category: Category;
	text: string;
	/** Absolute path of a file read or a single-file Bash print command. */
	path?: string;
	/** 1-based starting line parsed from a read-widening banner when present. */
	offset?: number;
	/** Content block index replaced on multi-block read results. */
	blockIndex?: number;
	/** True when every active Bash command segment invoked rtk directly. */
	wrapped?: boolean;
}

type ShellToken =
	| {
			kind: "word";
			value: string;
			dynamic: boolean;
			quoted: boolean;
			assignment: boolean;
	  }
	| { kind: "redirect" };

interface SegmentInvocation {
	name: string;
	subcommand?: string;
	dynamic: boolean;
}

function textBlocks(
	content: readonly (TextContent | ImageContent)[],
): string[] | undefined {
	if (content.length === 0) return undefined;
	const texts: string[] = [];
	for (const block of content) {
		if (block.type !== "text" || typeof block.text !== "string")
			return undefined;
		texts.push(block.text);
	}
	return texts;
}

function skipSingleQuoted(command: string, from: number): number {
	let i = from;
	while (i < command.length && command[i] !== "'") i++;
	return i < command.length ? i + 1 : i;
}

function skipAnsiCQuoted(command: string, from: number): number {
	let i = from;
	while (i < command.length && command[i] !== "'") {
		i += command[i] === "\\" ? 2 : 1;
	}
	return Math.min(command.length, i < command.length ? i + 1 : i);
}

function consumeBackticks(
	command: string,
	from: number,
): { inner: string; next: number } {
	let i = from;
	let inner = "";
	while (i < command.length && command[i] !== "`") {
		if (command[i] === "\\" && i + 1 < command.length) {
			const escaped = command[i + 1] ?? "";
			if (escaped === "`" || escaped === "$" || escaped === "\\") {
				inner += escaped;
			} else if (escaped !== "\n") {
				inner += `\\${escaped}`;
			}
			i += 2;
			continue;
		}
		inner += command[i] ?? "";
		i++;
	}
	return { inner, next: i < command.length ? i + 1 : i };
}

function consumeDollarParen(
	command: string,
	from: number,
	depth = 0,
): { inner: string; next: number } {
	let i = from;
	let parens = 1;
	while (i < command.length && parens > 0) {
		const ch = command[i];
		if (ch === "\\") {
			i += 2;
		} else if (ch === "$" && command[i + 1] === "'") {
			i = skipAnsiCQuoted(command, i + 2);
		} else if (ch === "'") {
			i = skipSingleQuoted(command, i + 1);
		} else if (ch === '"') {
			i++;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\") {
					i += 2;
				} else if (
					command[i] === "$" &&
					command[i + 1] === "(" &&
					command[i + 2] !== "(" &&
					depth < 16
				) {
					i = consumeDollarParen(command, i + 2, depth + 1).next;
				} else if (command[i] === "`") {
					i = consumeBackticks(command, i + 1).next;
				} else {
					i++;
				}
			}
			if (i < command.length) i++;
		} else if (ch === "`") {
			i = consumeBackticks(command, i + 1).next;
		} else if (
			ch === "#" &&
			(i === from || /[\s;|&()]/.test(command[i - 1] ?? ""))
		) {
			while (i < command.length && command[i] !== "\n") i++;
		} else if (ch === "(") {
			parens++;
			i++;
		} else if (ch === ")") {
			parens--;
			if (parens === 0) {
				return { inner: command.slice(from, i), next: i + 1 };
			}
			i++;
		} else {
			i++;
		}
	}
	return { inner: command.slice(from), next: command.length };
}

function consumeDollarBrace(
	command: string,
	from: number,
	substitutions: string[],
	depth = 0,
): { next: number; unclosed: boolean } {
	let i = from;
	let braces = 1;
	let unclosed = false;
	while (i < command.length && braces > 0) {
		const ch = command[i];
		if (ch === "\\") {
			i += Math.min(2, command.length - i);
		} else if (ch === "$" && command[i + 1] === "'") {
			i = skipAnsiCQuoted(command, i + 2);
		} else if (ch === "'") {
			const next = skipSingleQuoted(command, i + 1);
			if (command[next - 1] !== "'") unclosed = true;
			i = next;
		} else if (ch === '"') {
			i++;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\") {
					i += Math.min(2, command.length - i);
				} else if (
					command[i] === "$" &&
					command[i + 1] === "(" &&
					command[i + 2] !== "("
				) {
					const sub = consumeDollarParen(command, i + 2);
					if (command[sub.next - 1] !== ")") unclosed = true;
					substitutions.push(sub.inner);
					i = sub.next;
				} else if (command[i] === "$" && command[i + 1] === "{") {
					const nested =
						depth < 16
							? consumeDollarBrace(command, i + 2, substitutions, depth + 1)
							: { next: i + 2, unclosed: true };
					if (nested.unclosed) unclosed = true;
					i = nested.next;
				} else if (command[i] === "`") {
					const sub = consumeBackticks(command, i + 1);
					if (command[sub.next - 1] !== "`") unclosed = true;
					substitutions.push(sub.inner);
					i = sub.next;
				} else {
					i++;
				}
			}
			if (i < command.length) i++;
			else unclosed = true;
		} else if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
			const sub = consumeDollarParen(command, i + 2);
			if (command[sub.next - 1] !== ")") unclosed = true;
			substitutions.push(sub.inner);
			i = sub.next;
		} else if (ch === "$" && command[i + 1] === "{") {
			const nested =
				depth < 16
					? consumeDollarBrace(command, i + 2, substitutions, depth + 1)
					: { next: i + 2, unclosed: true };
			if (nested.unclosed) unclosed = true;
			i = nested.next;
		} else if (ch === "`") {
			const sub = consumeBackticks(command, i + 1);
			if (command[sub.next - 1] !== "`") unclosed = true;
			substitutions.push(sub.inner);
			i = sub.next;
		} else if (ch === "{") {
			braces++;
			i++;
		} else if (ch === "}") {
			braces--;
			i++;
		} else {
			i++;
		}
	}
	if (braces > 0) unclosed = true;
	return { next: i, unclosed };
}

function consumeRedirectOperator(command: string, from: number): number {
	const two = command.slice(from, from + 2);
	const three = command.slice(from, from + 3);
	if (three === "<<-" || three === "<<<" || three === "&>>") return from + 3;
	if (
		two === "<<" ||
		two === ">>" ||
		two === "<&" ||
		two === ">&" ||
		two === "<>" ||
		two === ">|" ||
		two === "&>"
	) {
		return from + 2;
	}
	return from + 1;
}

function scanShellSegments(command: string): {
	segments: ShellToken[][];
	substitutions: string[];
	unclosed: boolean;
} {
	const segments: ShellToken[][] = [];
	const substitutions: string[] = [];
	let current: ShellToken[] = [];
	let unclosed = false;

	let wordActive = false;
	let wordValue = "";
	let wordDynamic = false;
	let wordQuoted = false;
	let wordAssignment = false;
	let sawEquals = false;

	const resetWord = (): void => {
		wordActive = false;
		wordValue = "";
		wordDynamic = false;
		wordQuoted = false;
		wordAssignment = false;
		sawEquals = false;
	};

	const flushWord = (): void => {
		if (!wordActive) return;
		current.push({
			kind: "word",
			value: wordValue,
			dynamic: wordDynamic,
			quoted: wordQuoted,
			assignment: wordAssignment,
		});
		resetWord();
	};

	const flushSegment = (): void => {
		flushWord();
		if (current.length > 0) {
			segments.push(current);
			current = [];
		}
	};

	const consumeDollarInWord = (at: number): number => {
		if (command[at + 1] === "(" && command[at + 2] === "(") {
			const arith = consumeDollarParen(command, at + 2);
			if (command[arith.next - 1] !== ")") unclosed = true;
			wordActive = true;
			wordDynamic = true;
			return arith.next;
		}
		if (command[at + 1] === "(") {
			const sub = consumeDollarParen(command, at + 2);
			if (command[sub.next - 1] !== ")") unclosed = true;
			substitutions.push(sub.inner);
			wordActive = true;
			wordDynamic = true;
			return sub.next;
		}
		if (command[at + 1] === "{") {
			const brace = consumeDollarBrace(command, at + 2, substitutions);
			if (brace.unclosed) unclosed = true;
			wordActive = true;
			wordDynamic = true;
			return brace.next;
		}
		const nextChar = command[at + 1] ?? "";
		if (/[A-Za-z_0-9@#?*!$-]/.test(nextChar)) {
			wordActive = true;
			wordDynamic = true;
			let end = at + 2;
			if (/[A-Za-z_]/.test(nextChar)) {
				while (end < command.length && /[A-Za-z0-9_]/.test(command[end] ?? ""))
					end++;
			}
			return end;
		}
		wordActive = true;
		wordValue += "$";
		return at + 1;
	};

	let i = 0;
	while (i < command.length) {
		const ch = command[i] ?? "";
		if (ch === "\\" && command[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (ch === "\\" && command[i + 1] === "\r" && command[i + 2] === "\n") {
			i += 3;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			flushWord();
			i++;
			continue;
		}
		if (!wordActive && ch === "#") {
			while (i < command.length && command[i] !== "\n") i++;
			continue;
		}
		if (
			(ch === "<" || ch === ">") &&
			command[i + 1] === "(" &&
			(!wordActive ||
				(!wordQuoted && !wordDynamic && /^[0-9]+$/.test(wordValue)))
		) {
			if (wordActive) resetWord();
			const sub = consumeDollarParen(command, i + 2);
			if (command[sub.next - 1] !== ")") unclosed = true;
			substitutions.push(sub.inner);
			current.push({
				kind: "word",
				value: "",
				dynamic: true,
				quoted: false,
				assignment: false,
			});
			i = sub.next;
			continue;
		}
		if (
			ch === "<" ||
			ch === ">" ||
			(!wordActive && ch === "&" && command[i + 1] === ">")
		) {
			if (
				wordActive &&
				!wordQuoted &&
				!wordDynamic &&
				/^[0-9]+$/.test(wordValue)
			) {
				resetWord();
			} else {
				flushWord();
			}
			current.push({ kind: "redirect" });
			i = consumeRedirectOperator(command, i);
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
			flushSegment();
			i++;
			continue;
		}
		if (
			(ch === "&" && command[i + 1] === "&") ||
			(ch === "|" && (command[i + 1] === "|" || command[i + 1] === "&"))
		) {
			flushSegment();
			i += 2;
			continue;
		}
		if (ch === "|" || ch === "&") {
			flushSegment();
			i++;
			continue;
		}
		if (ch === "\\") {
			wordActive = true;
			wordQuoted = true;
			if (i + 1 < command.length) {
				wordValue += command[i + 1] ?? "";
				i += 2;
			} else {
				i++;
			}
			continue;
		}
		if (ch === "$" && command[i + 1] === "'") {
			wordActive = true;
			wordQuoted = true;
			const next = skipAnsiCQuoted(command, i + 2);
			if (command[next - 1] !== "'") unclosed = true;
			wordValue += command.slice(
				i + 2,
				next - (command[next - 1] === "'" ? 1 : 0),
			);
			i = next;
			continue;
		}
		if (ch === "'") {
			wordActive = true;
			wordQuoted = true;
			const next = skipSingleQuoted(command, i + 1);
			if (command[next - 1] !== "'") unclosed = true;
			wordValue += command.slice(
				i + 1,
				next - (command[next - 1] === "'" ? 1 : 0),
			);
			i = next;
			continue;
		}
		if (ch === '"') {
			wordActive = true;
			wordQuoted = true;
			i++;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && command[i + 1] === "\n") {
					i += 2;
				} else if (
					command[i] === "\\" &&
					command[i + 1] === "\r" &&
					command[i + 2] === "\n"
				) {
					i += 3;
				} else if (command[i] === "\\" && i + 1 < command.length) {
					const escaped = command[i + 1] ?? "";
					if (
						escaped === '"' ||
						escaped === "$" ||
						escaped === "`" ||
						escaped === "\\"
					) {
						wordValue += escaped;
					} else {
						wordValue += `\\${escaped}`;
					}
					i += 2;
				} else if (command[i] === "$") {
					i = consumeDollarInWord(i);
				} else if (command[i] === "`") {
					const sub = consumeBackticks(command, i + 1);
					if (command[sub.next - 1] !== "`") unclosed = true;
					substitutions.push(sub.inner);
					wordDynamic = true;
					i = sub.next;
				} else {
					wordValue += command[i] ?? "";
					i++;
				}
			}
			if (i < command.length) i++;
			else unclosed = true;
			continue;
		}
		if (ch === "$") {
			i = consumeDollarInWord(i);
			continue;
		}
		if (ch === "`") {
			const sub = consumeBackticks(command, i + 1);
			if (command[sub.next - 1] !== "`") unclosed = true;
			substitutions.push(sub.inner);
			wordActive = true;
			wordDynamic = true;
			i = sub.next;
			continue;
		}
		if (ch === "=" && !sawEquals) {
			sawEquals = true;
			if (
				!wordQuoted &&
				!wordDynamic &&
				/^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(wordValue)
			) {
				wordAssignment = true;
			}
		}
		wordActive = true;
		wordValue += ch;
		i++;
	}
	flushSegment();
	return { segments, substitutions, unclosed };
}

function scanShell(command: string): {
	sanitized: string;
	substitutions: string[];
	unclosedSubstitution: boolean;
} {
	const substitutions: string[] = [];
	let unclosedSubstitution = false;
	let out = "";
	let i = 0;
	while (i < command.length) {
		const ch = command[i] ?? "";
		if (ch === "\\" && command[i + 1] === "\n") {
			out += " ";
			i += 2;
		} else if (
			ch === "\\" &&
			command[i + 1] === "\r" &&
			command[i + 2] === "\n"
		) {
			out += " ";
			i += 3;
		} else if (ch === "\\") {
			out += " ";
			i += Math.min(2, command.length - i);
		} else if (ch === "$" && command[i + 1] === "'") {
			out += "''";
			i = skipAnsiCQuoted(command, i + 2);
		} else if (ch === "'") {
			out += "''";
			i = skipSingleQuoted(command, i + 1);
		} else if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
			const sub = consumeDollarParen(command, i + 2);
			if (command[sub.next - 1] !== ")") unclosedSubstitution = true;
			substitutions.push(sub.inner);
			out += "''";
			i = sub.next;
		} else if (ch === "`") {
			const sub = consumeBackticks(command, i + 1);
			if (command[sub.next - 1] !== "`") unclosedSubstitution = true;
			substitutions.push(sub.inner);
			out += "''";
			i = sub.next;
		} else if (ch === '"') {
			i++;
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && command[i + 1] === "\n") {
					i += 2;
				} else if (
					command[i] === "\\" &&
					command[i + 1] === "\r" &&
					command[i + 2] === "\n"
				) {
					i += 3;
				} else if (command[i] === "\\") {
					i += Math.min(2, command.length - i);
				} else if (
					command[i] === "$" &&
					command[i + 1] === "(" &&
					command[i + 2] !== "("
				) {
					const sub = consumeDollarParen(command, i + 2);
					if (command[sub.next - 1] !== ")") unclosedSubstitution = true;
					substitutions.push(sub.inner);
					i = sub.next;
				} else if (command[i] === "`") {
					const sub = consumeBackticks(command, i + 1);
					if (command[sub.next - 1] !== "`") unclosedSubstitution = true;
					substitutions.push(sub.inner);
					i = sub.next;
				} else {
					i++;
				}
			}
			if (i < command.length) i++;
			out += "''";
		} else if (
			ch === "#" &&
			(i === 0 || /[\s;|&()]/.test(command[i - 1] ?? ""))
		) {
			while (i < command.length && command[i] !== "\n") i++;
			out += " ";
		} else {
			out += ch;
			i++;
		}
	}
	return { sanitized: out, substitutions, unclosedSubstitution };
}

/** Join line continuations, strip unquoted escapes and comments, and blank quoted literals. */
export function sanitizeShell(command: string): string {
	return scanShell(command).sanitized;
}

function parseSegmentInvocation(
	tokens: readonly ShellToken[],
): SegmentInvocation | undefined {
	let index = 0;
	let lastPrefix: string | undefined;
	while (index < tokens.length) {
		const token = tokens[index];
		if (!token) break;
		if (token.kind === "redirect") {
			index += 2;
			continue;
		}
		if (
			!token.quoted &&
			!token.dynamic &&
			(token.value === "!" || token.value === "{" || token.value === "}")
		) {
			index++;
			continue;
		}
		if (token.assignment) {
			index++;
			continue;
		}
		if (token.dynamic || token.value === "") {
			return { name: "", dynamic: true };
		}
		const base = token.value.slice(token.value.lastIndexOf("/") + 1);
		if (SHELL_PREFIX.has(base)) {
			lastPrefix = base;
			index++;
			while (index < tokens.length) {
				const next = tokens[index];
				if (!next) break;
				if (next.kind === "redirect") {
					index += 2;
					continue;
				}
				if (!next.dynamic && next.value.startsWith("-")) {
					const flag = next.value;
					index++;
					if (flag === "--") break;
					if (base === "command" && /^-[A-Za-z]*[vV][A-Za-z]*$/.test(flag)) {
						return { name: "command", dynamic: false };
					}
					if (
						SHELL_PREFIX_FLAGS_WITH_ARG[base]?.has(flag) &&
						index < tokens.length
					) {
						index++;
					}
					continue;
				}
				break;
			}
			continue;
		}
		let subcommand: string | undefined;
		for (let sub = index + 1; sub < tokens.length; sub++) {
			const arg = tokens[sub];
			if (!arg) break;
			if (arg.kind === "redirect") {
				sub++;
				continue;
			}
			if (arg.value.startsWith("-")) continue;
			if (arg.dynamic) break;
			subcommand = arg.value;
			break;
		}
		return subcommand === undefined
			? { name: base, dynamic: false }
			: { name: base, subcommand, dynamic: false };
	}
	return lastPrefix === undefined
		? undefined
		: { name: lastPrefix, dynamic: false };
}

/** Return the leading safe program name for a shell command, or "?" when dynamic or unknown. */
export function leadingShellProgram(command: string): string {
	const { segments } = scanShellSegments(command);
	let fallback: string | undefined;
	for (const segment of segments) {
		const invocation = parseSegmentInvocation(segment);
		if (!invocation) continue;
		if (
			invocation.dynamic ||
			invocation.name.length > 64 ||
			!SAFE_PROGRAM_NAME.test(invocation.name)
		) {
			return "?";
		}
		fallback ??= invocation.name;
		if (!SHELL_SETUP.has(invocation.name)) return invocation.name;
	}
	return fallback ?? "?";
}

/** Leave rtk recall output untouched even behind prefixes, flags, subshells, or command substitutions. */
export function hasRtkRecall(command: string): boolean {
	const queue = [command];
	for (let cursor = 0; cursor < queue.length && cursor < 64; cursor++) {
		const current = queue[cursor] ?? "";
		const { segments, substitutions } = scanShellSegments(current);
		for (const segment of segments) {
			const invocation = parseSegmentInvocation(segment);
			if (
				invocation &&
				!invocation.dynamic &&
				invocation.name === "rtk" &&
				invocation.subcommand === "recall"
			) {
				return true;
			}
		}
		queue.push(...substitutions);
	}
	return false;
}

/** Return true when every non-setup shell segment and command substitution runs through an rtk filter subcommand. */
export function isRtkWrapped(command: string): boolean {
	const queue = [command];
	let topActive = 0;
	for (let cursor = 0; cursor < queue.length; cursor++) {
		if (cursor >= 64) return false;
		const current = queue[cursor] ?? "";
		const { segments, substitutions, unclosed } = scanShellSegments(current);
		if (unclosed) return false;
		for (const segment of segments) {
			const invocation = parseSegmentInvocation(segment);
			if (!invocation) continue;
			if (!invocation.dynamic && SHELL_SETUP.has(invocation.name)) continue;
			if (cursor === 0) topActive++;
			if (invocation.dynamic || invocation.name !== "rtk") return false;
			if (
				invocation.subcommand === undefined ||
				UNFILTERED_RTK_SUBCOMMANDS.has(invocation.subcommand)
			) {
				return false;
			}
		}
		queue.push(...substitutions);
	}
	return topActive > 0;
}

/** Return the filtering category for a tool name, or undefined when excluded. */
export function categoryFor(toolName: string): Category | undefined {
	if (EXCLUDED.has(toolName)) return undefined;
	if (toolName === "read") return "read";
	if (toolName === "bash") return "terminal";
	return LISTING.has(toolName) ? "listing" : "generic";
}

export function hasRawTerminalOutput(text: string): boolean {
	return text.includes("\u001b") || text.includes("\r");
}

/** Route a Pi tool_result event for filtering, or return undefined when skipped. */
export function select(event: ToolResultEvent, cwd: string): Route | undefined {
	const category = categoryFor(event.toolName);
	// Ignore nested tool calls because they feed caller scripts rather than the model.
	if (category === undefined || event.parentToolCallId !== undefined)
		return undefined;
	const blocks = textBlocks(event.content);
	if (!blocks) return undefined;

	if (event.toolName === "read") {
		if (event.isError || typeof event.input.path !== "string") return undefined;
		const path = resolvePath(event.input.path, cwd);
		if (blocks.length === 1) {
			const text = blocks[0] ?? "";
			return Buffer.byteLength(text) >= MIN_BYTES
				? { category: "read", text, path }
				: undefined;
		}
		if (blocks.length === 2) {
			const banner = blocks[0] ?? "";
			const text = blocks[1] ?? "";
			const widened = PI_LENS_WIDENED.exec(banner)?.[1];
			if (widened === undefined || Buffer.byteLength(text) < MIN_BYTES)
				return undefined;
			const offset = Number(widened);
			return {
				category: "read",
				text,
				path,
				blockIndex: 1,
				...(Number.isSafeInteger(offset) && offset > 0 ? { offset } : {}),
			};
		}
		return undefined;
	}

	const text = blocks.join("\n");
	if (Buffer.byteLength(text) < MIN_BYTES) return undefined;

	if (event.toolName === "bash") {
		const command = event.input.command;
		if (typeof command !== "string" || hasRtkRecall(command)) return undefined;
		const path =
			!event.isError && blocks.length === 1
				? bashFileView(command, cwd)
				: undefined;
		if (path !== undefined) return { category: "read", text, path };
		return isRtkWrapped(command)
			? { category: "terminal", text, wrapped: true }
			: { category: "terminal", text };
	}
	if (event.isError || category === "read" || category === "terminal")
		return undefined;
	return { category, text };
}

/** Prefix tool names for RTK so they match only generic post-tool rules. */
export function rtkToolName(toolName: string): string {
	return `pi-${toolName}`;
}

function rendered(line: string | undefined): string | undefined {
	if (line === undefined) return undefined;
	const visible = line.replace(ANSI_ESCAPE, "");
	if (!visible.includes("\r")) return visible;
	return (
		visible.split("\r").findLast((segment: string) => segment !== "") ?? ""
	);
}

function lastNonEmptyLines(text: string, limit: number): string[] {
	const lines = text.split("\n");
	const found: string[] = [];
	for (
		let index = lines.length - 1;
		index >= 0 && found.length < limit;
		index--
	) {
		const line = lines[index] ?? "";
		if ((rendered(line) ?? "").trim() !== "") found.push(line);
	}
	return found;
}

function trailingRepeatCount(text: string): number {
	const lines = text.split("\n");
	let index = lines.length - 1;
	while (index >= 0 && (rendered(lines[index]) ?? "").trim() === "") index--;
	if (index < 0) return 0;
	const target = rendered(lines[index]);
	let count = 0;
	while (index >= 0 && rendered(lines[index]) === target) {
		count++;
		index--;
	}
	return count;
}

function isBase64Code(code: number): boolean {
	return (
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 48 && code <= 57) ||
		code === 43 ||
		code === 47 ||
		code === 61
	);
}

function consumeBase64Span(
	text: string,
	from: number,
): { minEnd: number; spanEnd: number } | undefined {
	let cursor = from;
	let minEnd = -1;
	while (cursor < text.length) {
		const header = DATA_URL_HEADER.exec(text.slice(cursor))?.[0];
		const runStart = cursor + (header?.length ?? 0);
		let end = runStart;
		while (end < text.length && isBase64Code(text.charCodeAt(end))) end++;
		if (end - runStart < MIN_BASE64_RUN) {
			return minEnd < 0 ? undefined : { minEnd, spanEnd: cursor };
		}
		if (minEnd < 0) minEnd = runStart + MIN_BASE64_RUN;
		if (
			text.charCodeAt(end) === 58 &&
			end - 4 >= runStart + MIN_BASE64_RUN &&
			DATA_URL_HEADER.test(text.slice(end - 4))
		) {
			cursor = end - 4;
			continue;
		}
		cursor = end;
		if (!DATA_URL_HEADER.test(text.slice(cursor))) {
			return { minEnd, spanEnd: cursor };
		}
	}
	return minEnd < 0 ? undefined : { minEnd, spanEnd: cursor };
}

function withCompleteTrailingBase64Marker(prefix: string): string | undefined {
	const open = prefix.lastIndexOf("[");
	if (open < 0 || prefix.indexOf("]", open) >= 0) return undefined;
	const tail = prefix.slice(open);
	if (
		tail.startsWith(BASE64_MARKER_OPEN) ||
		BASE64_MARKER_OPEN.startsWith(tail)
	) {
		return `${prefix.slice(0, open)}[base64 data, 0 elided]`;
	}
	return undefined;
}

function matchesBase64Elided(
	original: string,
	filtered: string,
	prefixOnly = false,
): boolean {
	const parts = filtered.split(BASE64_ELIDED);
	if (parts.length < 2) return false;
	const head = parts[0] ?? "";
	if (!original.startsWith(head)) return false;
	let pos = head.length;
	for (let index = 1; index < parts.length; index++) {
		const span = consumeBase64Span(original, pos);
		if (!span) return false;
		const { minEnd, spanEnd } = span;
		const literal = parts[index] ?? "";
		const isLast = index === parts.length - 1;
		if (isLast && !prefixOnly) {
			const end = original.length - literal.length;
			return end >= minEnd && end <= spanEnd && original.endsWith(literal);
		}
		if (isLast && prefixOnly) {
			if (literal === "") return true;
			const next = original.indexOf(literal, minEnd);
			return (
				next >= 0 && next <= spanEnd && next + literal.length < original.length
			);
		}
		const next = original.indexOf(literal, minEnd);
		if (next < 0 || next > spanEnd) return false;
		pos = next + literal.length;
	}
	return false;
}

function matchesLastLine(
	original: string | undefined,
	filtered: string | undefined,
): boolean {
	const origVis = rendered(original);
	const filtVis = rendered(filtered);
	if (origVis === undefined || filtVis === undefined)
		return origVis === filtVis;
	if (origVis === filtVis) return true;
	if (matchesBase64Elided(origVis, filtVis)) return true;
	const capped = LONG_LINE_CAP.exec(filtVis);
	if (capped?.[1] !== undefined && capped[2] !== undefined) {
		const prefix = capped[1];
		const omitted = Number(capped[2]);
		if (
			omitted > 0 &&
			origVis.startsWith(prefix) &&
			[...origVis].length - [...prefix].length === omitted
		) {
			return true;
		}
		// Handle lines where base64-elide ran before cap, including mid-marker cuts.
		if (omitted > 0) {
			if (matchesBase64Elided(origVis, prefix, true)) return true;
			const completed = withCompleteTrailingBase64Marker(prefix);
			if (
				completed !== undefined &&
				matchesBase64Elided(origVis, completed, true)
			)
				return true;
		}
	}
	return false;
}

/** Verify that the final status line and all full-output notices survived filtering. */
export function preservesTrailer(original: string, filtered: string): boolean {
	const body = filtered.replace(RECALL_HINT, "");
	const [origLast] = lastNonEmptyLines(original, 1);
	const [filtLast, filtPrev] = lastNonEmptyLines(body, 2);
	const dedupMatch = filtLast !== undefined ? DEDUP_COUNT.exec(filtLast) : null;
	const dedupCount = dedupMatch?.[1] ? Number(dedupMatch[1]) : 0;
	const dedupedTail =
		dedupCount >= MIN_DEDUP_RUN &&
		trailingRepeatCount(original) === dedupCount &&
		matchesLastLine(origLast, filtPrev);
	if (!dedupedTail && !matchesLastLine(origLast, filtLast)) return false;
	const kept = new Set(body.split("\n"));
	return original
		.split("\n")
		.every((line: string) => !FULL_OUTPUT_NOTICE.test(line) || kept.has(line));
}

export function structureCheck(pipeline: Pipeline): StructureCheck {
	if (pipeline !== "listing") return preservesTrailer;
	return (original: string, filtered: string): boolean =>
		preservesTrailer(original, filtered) &&
		// Check FFF group boundaries when override-mode output uses native tool names.
		(!original.split("\n").some((line: string) => NUMBERED_LINE.test(line)) ||
			preservesBoundaries(original, filtered));
}

/** Return false when RTK's head/tail line cap would drop FFF file-group boundaries. */
export function canCapListing(
	text: string,
	headLines = 50,
	tailLines = 200,
	maxLines = 300,
): boolean {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return true;
	if (!lines.some((line: string) => NUMBERED_LINE.test(line))) return true;
	const simulated = [
		...lines.slice(0, headLines),
		`[... ${lines.length - headLines - tailLines} lines elided ...]`,
		...lines.slice(-tailLines),
	].join("\n");
	return preservesBoundaries(text, simulated);
}

export const MIN_SAVED_BYTES = 128;
export const MIN_SAVED_RATIO = 0.1;

export function worthReplacing(original: string, replacement: string): boolean {
	return (
		Buffer.byteLength(original) - Buffer.byteLength(replacement) >=
		MIN_SAVED_BYTES
	);
}

export function worthCondensing(
	original: string,
	replacement: string,
): boolean {
	const before = Buffer.byteLength(original);
	const saved = before - Buffer.byteLength(replacement);
	return saved >= MIN_SAVED_BYTES && saved >= before * MIN_SAVED_RATIO;
}
