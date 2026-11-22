import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { preservesBoundaries } from "../bridge.ts";
import { createGate, exceedsCap, ruleMethods } from "../gate.ts";
import {
	canCapListing,
	categoryFor,
	hasRawTerminalOutput,
	isRtkWrapped,
	MIN_BYTES,
	MIN_SAVED_BYTES,
	preservesTrailer,
	rtkToolName,
	sanitizeShell,
	select,
	structureCheck,
	worthCondensing,
	worthReplacing,
} from "../policy.ts";

const BUNDLED_RTK_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"rtk",
);

function makeEvent(overrides: {
	toolName: string;
	input?: Record<string, unknown>;
	content?: (TextContent | ImageContent)[];
	isError?: boolean;
	parentToolCallId?: string;
}): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "tc-1",
		toolName: overrides.toolName,
		input: overrides.input ?? {},
		content: overrides.content ?? [
			{ type: "text", text: "x".repeat(MIN_BYTES) },
		],
		isError: overrides.isError ?? false,
		details: undefined,
		...(overrides.parentToolCallId !== undefined
			? { parentToolCallId: overrides.parentToolCallId }
			: {}),
	} as ToolResultEvent;
}

function makeFffSingleFile(count: number, heading = "src/app.ts"): string {
	return [
		heading,
		...Array.from({ length: count }, (_, i) => ` ${i + 1}: const x = ${i};`),
	].join("\n");
}

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "rtk-gate-test-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("isRtkWrapped", () => {
	it("recognizes simple and full-path rtk commands and rejects unwrapped ones", () => {
		assert.equal(isRtkWrapped("rtk git status"), true);
		assert.equal(isRtkWrapped("/usr/local/bin/rtk git diff --stat"), true);
		assert.equal(isRtkWrapped("git status"), false);
		assert.equal(isRtkWrapped(""), false);
		assert.equal(isRtkWrapped("rtk"), false);
		assert.equal(isRtkWrapped("rtk --version"), false);
	});

	it("evaluates compound shell operators (&&, ||, ;, |, newline)", () => {
		assert.equal(isRtkWrapped("rtk git status && rtk git diff"), true);
		assert.equal(isRtkWrapped("rtk test || rtk lint"), true);
		assert.equal(isRtkWrapped("rtk ls; rtk git log\nrtk git status"), true);
		assert.equal(isRtkWrapped("rtk git status && ls"), false);
		assert.equal(isRtkWrapped("rtk git status | head -n 20"), false);
		assert.equal(isRtkWrapped("echo hi; rtk git status"), false);
	});

	it("ignores SHELL_SETUP commands but requires at least one active rtk segment", () => {
		assert.equal(
			isRtkWrapped(
				"cd /repo && export NODE_ENV=test && unset DEBUG && umask 022 && set -e && true && : && rtk vitest run",
			),
			true,
		);
		assert.equal(
			isRtkWrapped(
				"pushd /tmp && popd && shopt -s globstar && source .env && . ./vars && trap '' INT && rtk ls",
			),
			true,
		);
		assert.equal(isRtkWrapped("cd /repo && export FOO=1"), false);
	});

	it("handles SHELL_PREFIX, SHELL_PREFIX_FLAGS_WITH_ARG, --, and VAR=val assignments", () => {
		assert.equal(isRtkWrapped("FOO=1 BAR=2 rtk git status"), true);
		assert.equal(isRtkWrapped("env FOO=1 rtk git status"), true);
		assert.equal(isRtkWrapped("/usr/bin/env -u DEBUG rtk git status"), true);
		assert.equal(isRtkWrapped("env -C /tmp rtk ls"), true);
		assert.equal(isRtkWrapped("env -S 'FOO=1' rtk ls"), true);
		assert.equal(isRtkWrapped("env --unset DEBUG --chdir /tmp rtk ls"), true);
		assert.equal(isRtkWrapped("env --split-string foo rtk ls"), true);
		assert.equal(isRtkWrapped("nice -n 10 rtk cargo test"), true);
		assert.equal(isRtkWrapped("nice --adjustment 5 rtk cargo test"), true);
		assert.equal(isRtkWrapped("exec -a myrtk rtk git status"), true);
		assert.equal(isRtkWrapped("env -- rtk git status"), true);
		assert.equal(isRtkWrapped("command -- rtk git status"), true);
		assert.equal(isRtkWrapped("time nohup nice -n 5 env -u FOO rtk ls"), true);

		// Flag arguments named "rtk" must NOT be mistaken for the rtk program!
		assert.equal(isRtkWrapped("env -u rtk python3 app.py"), false);
		assert.equal(isRtkWrapped("env --unset rtk python3 app.py"), false);
		assert.equal(isRtkWrapped("env -C rtk ls"), false);
		assert.equal(isRtkWrapped("nice -n rtk ls"), false);
		assert.equal(isRtkWrapped("exec -a rtk python3 app.py"), false);
	});

	it("rejects UNFILTERED_RTK_SUBCOMMANDS (read, bypass, proxy, run, recall)", () => {
		for (const sub of ["read", "bypass", "proxy", "run", "recall"]) {
			assert.equal(isRtkWrapped(`rtk ${sub} arg`), false, sub);
			assert.equal(
				isRtkWrapped(`rtk --quiet ${sub} arg`),
				false,
				`--quiet ${sub}`,
			);
		}
	});

	it("ignores shell operators inside quotes and handles line continuations", () => {
		assert.equal(isRtkWrapped('rtk git log --grep="a && b || c; d | e"'), true);
		assert.equal(isRtkWrapped("rtk git log --grep='x && y | z'"), true);
		assert.equal(isRtkWrapped("cd /repo && \\\nrtk git status"), true);
	});

	it("handles unquoted backslash escapes, ANSI-C $'...' quotes, command substitutions, comments, and URL #fragments", () => {
		assert.equal(isRtkWrapped("# check author's status\nrtk git status"), true);
		assert.equal(isRtkWrapped("export SEP=$'a\\'b' && rtk git status"), true);
		assert.equal(isRtkWrapped("export SEP=$'a\\'b' && git status"), false);
		assert.equal(isRtkWrapped('rtk git log "$(cat huge.log)"'), false);
		assert.equal(isRtkWrapped("rtk git log $(cat huge.log)"), false);
		assert.equal(isRtkWrapped("rtk git log `cat huge.log`"), false);
		assert.equal(isRtkWrapped('rtk git log "$(rtk git status)"'), true);
		assert.equal(
			isRtkWrapped("rtk git log --grep=\\'foo && git status"),
			false,
		);
		assert.equal(
			sanitizeShell("curl https://example.com/api#frag && rtk status"),
			"curl https://example.com/api#frag && rtk status",
		);
	});
});

describe("categoryFor / hasRawTerminalOutput / rtkToolName", () => {
	it("maps tool names to categories and excludes edit/write", () => {
		assert.equal(categoryFor("edit"), undefined);
		assert.equal(categoryFor("write"), undefined);
		assert.equal(categoryFor("read"), "read");
		assert.equal(categoryFor("bash"), "terminal");
		for (const tool of [
			"grep",
			"find",
			"ls",
			"ffgrep",
			"fffind",
			"fff-multi-grep",
			"multi_grep",
		]) {
			assert.equal(categoryFor(tool), "listing", tool);
		}
		assert.equal(categoryFor("web_fetch"), "generic");
		assert.equal(categoryFor("custom_mcp"), "generic");
	});

	it("detects raw terminal escapes and prefixes rtk tool names", () => {
		assert.equal(hasRawTerminalOutput("\u001b[31mred\u001b[0m"), true);
		assert.equal(hasRawTerminalOutput("step 1\rstep 2"), true);
		assert.equal(hasRawTerminalOutput("clean output\nline 2"), false);
		assert.equal(rtkToolName("bash"), "pi-bash");
		assert.equal(rtkToolName("grep"), "pi-grep");
	});
});

describe("select", () => {
	const cwd = "/workspace/repo";
	const big = "x".repeat(MIN_BYTES);

	it("skips excluded, nested, image, empty, and under-MIN_BYTES events", () => {
		assert.equal(select(makeEvent({ toolName: "edit" }), cwd), undefined);
		assert.equal(select(makeEvent({ toolName: "write" }), cwd), undefined);
		assert.equal(
			select(
				makeEvent({ toolName: "grep", parentToolCallId: "parent-1" }),
				cwd,
			),
			undefined,
		);
		assert.equal(
			select(makeEvent({ toolName: "grep", content: [] }), cwd),
			undefined,
		);
		assert.equal(
			select(
				makeEvent({
					toolName: "read",
					input: { path: "img.png" },
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
				}),
				cwd,
			),
			undefined,
		);
		assert.equal(
			select(
				makeEvent({
					toolName: "grep",
					content: [{ type: "text", text: "x".repeat(MIN_BYTES - 1) }],
				}),
				cwd,
			),
			undefined,
		);
		// Multi-byte UTF-8: 171 * 3 = 513 bytes >= 512 even though .length is 171.
		assert.notEqual(
			select(
				makeEvent({
					toolName: "grep",
					content: [{ type: "text", text: "€".repeat(171) }],
				}),
				cwd,
			),
			undefined,
		);
	});

	it("routes read results including pi-lens widened 2-block reads", () => {
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "read",
					input: { path: "src/app.ts" },
					content: [{ type: "text", text: big }],
				}),
				cwd,
			),
			{
				category: "read",
				text: big,
				path: resolve(cwd, "src/app.ts"),
			},
		);

		// Error or missing path skipped for read.
		assert.equal(
			select(
				makeEvent({
					toolName: "read",
					input: { path: "src/app.ts" },
					isError: true,
				}),
				cwd,
			),
			undefined,
		);
		assert.equal(
			select(makeEvent({ toolName: "read", input: {} }), cwd),
			undefined,
		);

		// pi-lens widened 2-block read
		const widenedBanner =
			"[pi-lens: read widened from 50-80 to fit symbol; this shows lines 42-120]";
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "read",
					input: { path: "@src/app.ts" },
					content: [
						{ type: "text", text: widenedBanner },
						{ type: "text", text: big },
					],
				}),
				cwd,
			),
			{
				category: "read",
				text: big,
				path: resolve(cwd, "src/app.ts"),
				blockIndex: 1,
				offset: 42,
			},
		);

		// Non-widened 2-block read or 3-block read or short body skipped
		assert.equal(
			select(
				makeEvent({
					toolName: "read",
					input: { path: "src/app.ts" },
					content: [
						{ type: "text", text: "some other notice" },
						{ type: "text", text: big },
					],
				}),
				cwd,
			),
			undefined,
		);
		assert.equal(
			select(
				makeEvent({
					toolName: "read",
					input: { path: "src/app.ts" },
					content: [
						{ type: "text", text: widenedBanner },
						{ type: "text", text: "short" },
					],
				}),
				cwd,
			),
			undefined,
		);
		assert.equal(
			select(
				makeEvent({
					toolName: "read",
					input: { path: "src/app.ts" },
					content: [
						{ type: "text", text: widenedBanner },
						{ type: "text", text: big },
						{ type: "text", text: "extra" },
					],
				}),
				cwd,
			),
			undefined,
		);
	});

	it("routes bash file views, wrapped commands, errors, and skips rtk recall", () => {
		// Single-file cat routed as read
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "bash",
					input: { command: "cat src/a.ts" },
					content: [{ type: "text", text: big }],
				}),
				cwd,
			),
			{
				category: "read",
				text: big,
				path: resolve(cwd, "src/a.ts"),
			},
		);

		// Failed single-file cat routes to terminal (not read)
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "bash",
					input: { command: "cat src/a.ts" },
					content: [{ type: "text", text: big }],
					isError: true,
				}),
				cwd,
			),
			{ category: "terminal", text: big },
		);

		// Wrapped bash command sets wrapped: true
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "bash",
					input: { command: "rtk git status" },
					content: [{ type: "text", text: big }],
				}),
				cwd,
			),
			{ category: "terminal", text: big, wrapped: true },
		);

		// rtk recall skipped (including compound, absolute path, unquoted \' escape, and # comment)
		for (const cmd of [
			"rtk recall 0123456789abcdef",
			"cd /tmp && /usr/local/bin/rtk recall 0123456789abcdef --full",
			"echo ok; rtk recall deadbeef01234567",
			"echo \\' && rtk recall 0123456789abcdef",
			"# inspect user's log\nrtk recall 0123456789abcdef",
			"export SEP=$'a\\'b' && rtk recall 0123456789abcdef",
			"rtk -v recall 0123456789abcdef",
			"env FOO=1 rtk --skip-env recall 0123456789abcdef",
			"(rtk recall 0123456789abcdef)",
			'echo "$(rtk recall 0123456789abcdef)"',
			"echo `rtk recall 0123456789abcdef`",
		]) {
			assert.equal(
				select(
					makeEvent({
						toolName: "bash",
						input: { command: cmd },
						content: [{ type: "text", text: big }],
					}),
					cwd,
				),
				undefined,
				cmd,
			);
		}

		// Quoted "rtk recall" in echo is NOT an rtk recall invocation.
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "bash",
					input: { command: 'echo "rtk recall deadbeef01234567"' },
					content: [{ type: "text", text: big }],
				}),
				cwd,
			),
			{ category: "terminal", text: big },
		);
	});

	it("routes listing and generic tools, joins multi-block text, and skips their errors", () => {
		const half = "y".repeat(MIN_BYTES / 2);
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "ffgrep",
					content: [
						{ type: "text", text: half },
						{ type: "text", text: half },
					],
				}),
				cwd,
			),
			{ category: "listing", text: `${half}\n${half}` },
		);
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "mcp_search",
					content: [{ type: "text", text: big }],
				}),
				cwd,
			),
			{ category: "generic", text: big },
		);
		assert.equal(
			select(makeEvent({ toolName: "grep", isError: true }), cwd),
			undefined,
		);
		assert.equal(
			select(makeEvent({ toolName: "mcp_search", isError: true }), cwd),
			undefined,
		);
	});
});

describe("preservesTrailer", () => {
	const hint = "\n[full output: rtk recall 0123456789abcdef]";

	it("accepts matching final non-empty lines with ANSI escapes, CR progress, and recall hints", () => {
		assert.equal(
			preservesTrailer(
				"header\n\u001b[32mPASS 42 tests\u001b[0m\n\n",
				`PASS 42 tests${hint}`,
			),
			true,
		);
		assert.equal(
			preservesTrailer(
				"downloading 10%\rdownloading 50%\rdownloading 100%\r\n\u001b[31m   \u001b[0m",
				`downloading 100%${hint}`,
			),
			true,
		);
		assert.equal(
			preservesTrailer("first\nlast-ok", `first\nchanged${hint}`),
			false,
		);
	});

	it("accepts valid [xN] dedup tails and rejects wrong counts or N < 3", () => {
		const orig = "intro\nrepeat line\nrepeat line\nrepeat line\nrepeat line";
		assert.equal(
			preservesTrailer(orig, `intro\nrepeat line\n[x4]${hint}`),
			true,
		);
		assert.equal(
			preservesTrailer(orig, `intro\nrepeat line\n[x3]${hint}`),
			false,
		);
		assert.equal(preservesTrailer("a\nb\nb", `a\nb\n[x2]${hint}`), false);
	});

	it("accepts valid raw, data-URL, and adjacent base64 elisions and rejects short runs", () => {
		const b64 = "A".repeat(1_024);
		assert.equal(
			preservesTrailer(
				`payload=${b64}!`,
				`payload=[base64 data, 1024 chars elided]!${hint}`,
			),
			true,
		);
		assert.equal(
			preservesTrailer(
				`img=data:image/png;base64,${b64};end`,
				`img=[base64 image/png, 1024 chars elided];end${hint}`,
			),
			true,
		);
		// Adjacent raw + data URL elided
		assert.equal(
			preservesTrailer(
				`x=${b64}data:image/jpeg;base64,${b64}z`,
				`x=[base64 data, 1024 chars elided][base64 image/jpeg, 1024 chars elided]z${hint}`,
			),
			true,
		);
		// Short (< 1024) base64 run must be rejected
		const shortB64 = "A".repeat(1_023);
		assert.equal(
			preservesTrailer(
				`payload=${shortB64}!`,
				`payload=[base64 data, 1023 chars elided]!${hint}`,
			),
			false,
		);
	});

	it("accepts valid long-line cap markers (including Unicode and combined base64-elide + mid-marker cut)", () => {
		const orig = `${"😀".repeat(10)}${"a".repeat(20)}`; // 30 code points
		assert.equal(
			preservesTrailer(orig, `${"😀".repeat(10)} [+20 chars]${hint}`),
			true,
		);
		assert.equal(
			preservesTrailer(orig, `${"😀".repeat(10)} [+19 chars]${hint}`),
			false,
		);
		assert.equal(preservesTrailer(orig, `${orig} [+0 chars]${hint}`), false);

		// Base64 elision followed by long-line cap
		const b64 = "B".repeat(1_024);
		const origB64 = `prefix:${b64}:suffix-tail`;
		assert.equal(
			preservesTrailer(
				origB64,
				`prefix:[base64 data, 1024 chars elided]:suf [+8 chars]${hint}`,
			),
			true,
		);
		// Cap cuts inside the `[base64 ...` marker itself
		assert.equal(
			preservesTrailer(origB64, `prefix:[base64 da [+40 chars]${hint}`),
			true,
		);
	});

	it("requires every Pi [.*Full output: .*] notice to survive filtering", () => {
		const notice = "[Showing last 2000 lines. Full output: /tmp/pi-out.txt]";
		const orig = `body\n\n${notice}\n\nCommand exited with code 1`;
		assert.equal(
			preservesTrailer(
				orig,
				`short\n\n${notice}\n\nCommand exited with code 1${hint}`,
			),
			true,
		);
		assert.equal(
			preservesTrailer(orig, `short\n\nCommand exited with code 1${hint}`),
			false,
		);
	});
});

describe("structureCheck / canCapListing / preservesBoundaries", () => {
	it("uses preservesTrailer for terminal and generic, and adds boundary checks for listing", () => {
		assert.equal(structureCheck("terminal"), preservesTrailer);
		assert.equal(structureCheck("generic"), preservesTrailer);

		const check = structureCheck("listing");
		const multiFile = [
			"src/a.ts",
			" 1: alpha",
			" 2: beta",
			"",
			"src/b.ts",
			" 10: gamma",
		].join("\n");

		// Preserves both headings + trailer -> true
		assert.equal(
			check(multiFile, "src/a.ts\n 1: alpha\nsrc/b.ts\n 10: gamma"),
			true,
		);
		// Drops second file heading -> false!
		assert.equal(check(multiFile, "src/a.ts\n 1: alpha\n 10: gamma"), false);
		// Non-FFF listing without numbered lines only checks trailer
		assert.equal(check("a.ts:1:foo\nb.ts:2:bar", "b.ts:2:bar"), true);
	});

	it("handles preservesBoundaries edge cases including fuzzy-match annotation and orphan numbered lines", () => {
		const fuzzy = [
			"[0 exact matches. Maybe you meant this?]",
			"src/a.ts",
			" 1: closeMatch()",
		].join("\n");
		assert.equal(preservesBoundaries(fuzzy, fuzzy), true);

		const orphanAfterFuzzy = [
			"[0 exact matches. Maybe you meant this?]",
			" 1: orphan()",
		].join("\n");
		assert.equal(
			preservesBoundaries(orphanAfterFuzzy, orphanAfterFuzzy),
			false,
		);
	});

	it("evaluates canCapListing across <=300, single-file, multi-file, Pi grep, and orphan numbered lines", () => {
		// <= 300 lines always allowed
		assert.equal(canCapListing(makeFffSingleFile(299)), true);

		// Pi grep (> 300 lines, no ` N: ` numbered lines) -> allowed
		const piGrep = Array.from(
			{ length: 350 },
			(_, i) => `src/file${i}.ts:${i + 1}:match`,
		).join("\n");
		assert.equal(canCapListing(piGrep), true);

		// Single-file FFF > 300 lines -> allowed (heading is at line 0, inside head=50)
		assert.equal(canCapListing(makeFffSingleFile(350)), true);

		// Multi-file FFF > 300 lines with heading in elided middle (line 80) -> false!
		const multiMid = [
			"src/a.ts",
			...Array.from({ length: 79 }, (_, i) => ` ${i + 1}: hit`),
			"src/middle.ts",
			...Array.from({ length: 260 }, (_, i) => ` ${i + 1}: hit`),
		].join("\n");
		assert.equal(canCapListing(multiMid), false);

		// Multi-file FFF > 300 lines with headings ONLY in head (<50) and tail (>= len-200) -> true!
		const multiEdges = [
			"src/head1.ts",
			" 1: a",
			"src/head2.ts",
			...Array.from({ length: 200 }, (_, i) => ` ${i + 1}: body`),
			"src/tail1.ts",
			...Array.from({ length: 150 }, (_, i) => ` ${i + 1}: tail`),
		].join("\n");
		assert.equal(canCapListing(multiEdges), true);

		// Numbered line without heading (> 300 lines) -> false!
		const noHeading = Array.from(
			{ length: 310 },
			(_, i) => ` ${i + 1}: orphan`,
		).join("\n");
		assert.equal(canCapListing(noHeading), false);
	});
});

describe("exceedsCap / ruleMethods / createGate", () => {
	it("checks exceedsCap line count (300) and line length (2000) thresholds", () => {
		const exact300 = Array.from({ length: 300 }, () => "a".repeat(2_000)).join(
			"\n",
		);
		assert.equal(exceedsCap(exact300), false);
		assert.equal(exceedsCap(`${exact300}\nextra`), true);
		assert.equal(exceedsCap("a".repeat(2_001)), true);
	});

	it("parses bundled and custom pipeline.toml files via ruleMethods", () => {
		assert.deepEqual(ruleMethods(join(BUNDLED_RTK_ROOT, "terminal")), [
			"ansi",
			"progress",
			"dedup",
			"base64-elide",
			"cap",
		]);
		assert.deepEqual(ruleMethods(join(BUNDLED_RTK_ROOT, "listing")), [
			"ansi",
			"cap",
		]);
		assert.deepEqual(ruleMethods(join(BUNDLED_RTK_ROOT, "generic")), [
			"ansi",
			"base64-elide",
			"dedup",
		]);

		withTempDir((dir) => {
			// Disabled rule returns []
			writeFileSync(
				join(dir, "pipeline.toml"),
				'[[hook.after_tool.any]]\nenabled = false\nuse = ["ansi"]\n',
			);
			assert.deepEqual(ruleMethods(dir), []);

			// Unknown method returns undefined
			writeFileSync(
				join(dir, "pipeline.toml"),
				'[[hook.after_tool.any]]\nuse = ["ansi", "custom-unknown"]\n',
			);
			assert.equal(ruleMethods(dir), undefined);

			// Multiple [[...]] tables returns undefined
			writeFileSync(
				join(dir, "pipeline.toml"),
				'[[hook.after_tool.any]]\nuse = ["ansi"]\n[[hook.after_tool.any]]\nuse = ["cap"]\n',
			);
			assert.equal(ruleMethods(dir), undefined);

			// Wrong hook table returns undefined
			writeFileSync(
				join(dir, "pipeline.toml"),
				'[[hook.before_tool.any]]\nuse = ["ansi"]\n',
			);
			assert.equal(ruleMethods(dir), undefined);

			// Presence of pipelines/ subdirectory returns undefined
			writeFileSync(
				join(dir, "pipeline.toml"),
				'[[hook.after_tool.any]]\nuse = ["ansi"]\n',
			);
			mkdirSync(join(dir, "pipelines"));
			assert.equal(ruleMethods(dir), undefined);
		});
	});

	it("gates bundled terminal, listing, and generic profiles accurately", () => {
		const gate = createGate(BUNDLED_RTK_ROOT);
		const clean = "normal line 1\nnormal line 2\nnormal line 3";

		assert.equal(gate("terminal", clean), false);
		assert.equal(gate("terminal", "\u001b[32mok\u001b[0m"), true);
		assert.equal(gate("terminal", "10%\r100%"), true);
		assert.equal(gate("terminal", "same\nsame\nsame"), true);
		// Blank lines do NOT count as repeated runs for dedup
		assert.equal(gate("terminal", "a\n\n\n\nb"), false);
		assert.equal(gate("terminal", `img=${"A".repeat(1_024)}`), true);
		assert.equal(gate("terminal", Array(301).fill("x").join("\n")), true);

		// Generic does NOT include cap or progress
		assert.equal(gate("generic", clean), false);
		assert.equal(gate("generic", "10%\r100%"), false);
		assert.equal(
			gate(
				"generic",
				Array.from({ length: 305 }, (_, i) => `line-${i}`).join("\n"),
			),
			false,
		);
		assert.equal(gate("generic", "\u001b[31merr\u001b[0m"), true);
		assert.equal(gate("generic", "dup\ndup\ndup"), true);
		assert.equal(gate("generic", `b64=${"Z".repeat(1_024)}`), true);

		// Listing rejects multi-file FFF >300 lines with middle heading EVEN WITH ANSI!
		const multiFileAnsi = [
			"\u001b[35msrc/a.ts\u001b[0m",
			...Array.from({ length: 80 }, (_, i) => ` ${i + 1}: match`),
			"src/middle.ts",
			...Array.from({ length: 260 }, (_, i) => ` ${i + 1}: match`),
		].join("\n");
		assert.equal(gate("listing", multiFileAnsi), false);

		// Single-file FFF >300 lines IS gated through listing
		assert.equal(gate("listing", makeFffSingleFile(350)), true);
		assert.equal(gate("listing", clean), false);
	});

	it("allows multi-file FFF >300 with ANSI when custom listing pipeline omits cap, caches by mtime, and falls back on missing files", () => {
		withTempDir((root) => {
			const listingDir = join(root, "listing");
			mkdirSync(listingDir, { recursive: true });
			const tomlPath = join(listingDir, "pipeline.toml");
			writeFileSync(tomlPath, '[[hook.after_tool.any]]\nuse = ["ansi"]\n');

			const gate = createGate(root);
			const multiFileAnsi = [
				"\u001b[35msrc/a.ts\u001b[0m",
				...Array.from({ length: 80 }, (_, i) => ` ${i + 1}: match`),
				"src/middle.ts",
				...Array.from({ length: 260 }, (_, i) => ` ${i + 1}: match`),
			].join("\n");

			// Without cap in listing pipeline, ANSI triggers gate even for multi-file FFF >300!
			assert.equal(gate("listing", multiFileAnsi), true);
			assert.equal(gate("listing", "plain short"), false);

			// Update pipeline.toml with a bumped mtime to add cap -> cache invalidates!
			writeFileSync(
				tomlPath,
				'[[hook.after_tool.any]]\nuse = ["ansi", "cap"]\n',
			);
			const future = new Date(Date.now() + 60_000);
			utimesSync(tomlPath, future, future);
			assert.equal(gate("listing", multiFileAnsi), false);

			// Missing profile falls back to true
			assert.equal(gate("terminal", "plain short"), true);
		});
	});
});

describe("worthReplacing / worthCondensing", () => {
	it("enforces MIN_SAVED_BYTES (128) on worthReplacing using UTF-8 byte lengths", () => {
		const base = "a".repeat(300);
		assert.equal(worthReplacing(base, "a".repeat(300 - MIN_SAVED_BYTES)), true);
		assert.equal(
			worthReplacing(base, "a".repeat(300 - MIN_SAVED_BYTES + 1)),
			false,
		);
		// Multi-byte UTF-8: removing 43 '€' chars saves 129 bytes >= 128
		assert.equal(worthReplacing("€".repeat(100), "€".repeat(57)), true);
		// Removing 42 '€' chars saves 126 bytes < 128
		assert.equal(worthReplacing("€".repeat(100), "€".repeat(58)), false);
	});

	it("enforces both MIN_SAVED_BYTES (128) and MIN_SAVED_RATIO (10%) on worthCondensing", () => {
		// 2000 -> 1850 saves 150 bytes (>= 128) but only 7.5% (< 10%) -> false
		assert.equal(worthCondensing("a".repeat(2_000), "a".repeat(1_850)), false);
		// 2000 -> 1800 saves 200 bytes (>= 128) and exactly 10% -> true
		assert.equal(worthCondensing("a".repeat(2_000), "a".repeat(1_800)), true);
		// 500 -> 400 saves 20% (>= 10%) but only 100 bytes (< 128) -> false
		assert.equal(worthCondensing("a".repeat(500), "a".repeat(400)), false);
		// 500 -> 372 saves 128 bytes and 25.6% -> true
		assert.equal(worthCondensing("a".repeat(500), "a".repeat(372)), true);
	});
});
