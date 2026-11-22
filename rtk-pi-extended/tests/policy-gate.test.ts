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
import { createGate, exceedsCap, ruleMethods } from "../gate.ts";
import {
	canCapListing,
	categoryFor,
	hasRawTerminalOutput,
	hasRtkRecall,
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

describe("isRtkWrapped & category helpers", () => {
	it("evaluates compound operators, shell setup/prefixes, unfiltered subcommands, quotes, and substitutions", () => {
		assert.equal(isRtkWrapped("rtk git status && rtk git diff"), true);
		assert.equal(isRtkWrapped("rtk git status | head -n 20"), false);
		assert.equal(
			isRtkWrapped("cd /repo && export NODE_ENV=test && rtk vitest run"),
			true,
		);
		assert.equal(isRtkWrapped("cd /repo && export FOO=1"), false);
		assert.equal(isRtkWrapped("time nohup nice -n 5 env -u FOO rtk ls"), true);
		assert.equal(isRtkWrapped("env -u rtk python3 app.py"), false);
		assert.equal(isRtkWrapped("exec -a rtk python3 app.py"), false);
		assert.equal(isRtkWrapped("command -v rtk git"), false);
		assert.equal(isRtkWrapped("command -V rtk git"), false);
		assert.equal(isRtkWrapped("command -pv rtk git"), false);
		assert.equal(isRtkWrapped("command -p rtk git status"), true);
		assert.equal(isRtkWrapped("cat big.log & rtk git status"), false);
		assert.equal(isRtkWrapped("rtk git status 2>&1"), true);
		assert.equal(isRtkWrapped("2>/dev/null rtk git status"), true);
		assert.equal(isRtkWrapped('"rtk" git status'), true);
		assert.equal(isRtkWrapped("\\rtk git status"), true);
		assert.equal(isRtkWrapped(`FOO=\${BAR:-a b} rtk git status`), true);

		assert.equal(hasRtkRecall("command -v rtk recall"), false);
		assert.equal(hasRtkRecall("command -V rtk recall"), false);
		assert.equal(hasRtkRecall("command -pv rtk recall"), false);
		assert.equal(hasRtkRecall("command -p rtk recall 0123456789abcdef"), true);
		assert.equal(hasRtkRecall("\\rtk recall 0123456789abcdef"), true);
		assert.equal(hasRtkRecall('"rtk" recall 0123456789abcdef'), true);
		assert.equal(hasRtkRecall("2>/dev/null rtk recall 0123456789abcdef"), true);
		assert.equal(hasRtkRecall("rtk 2>/dev/null recall 0123456789abcdef"), true);
		assert.equal(hasRtkRecall("sleep 1 & rtk recall 0123456789abcdef"), true);
		assert.equal(
			hasRtkRecall(`FOO=\${BAR:-a b} rtk recall 0123456789abcdef`),
			true,
		);

		for (const sub of ["read", "bypass", "proxy", "run", "recall"]) {
			assert.equal(isRtkWrapped(`rtk --quiet ${sub} arg`), false, sub);
		}

		assert.equal(isRtkWrapped('rtk git log --grep="a && b | c"'), true);
		assert.equal(
			isRtkWrapped("# check author's status\nexport SEP=$'a\\'b' && rtk ls"),
			true,
		);
		assert.equal(isRtkWrapped('rtk git log "$(cat huge.log)"'), false);
		assert.equal(isRtkWrapped('rtk git log "$(rtk git status)"'), true);
		assert.equal(
			sanitizeShell("curl https://example.com/api#frag && rtk status"),
			"curl https://example.com/api#frag && rtk status",
		);
	});

	it("maps tool categories and detects raw terminal output", () => {
		assert.equal(categoryFor("edit"), undefined);
		assert.equal(categoryFor("write"), undefined);
		assert.equal(categoryFor("read"), "read");
		assert.equal(categoryFor("bash"), "terminal");
		assert.equal(categoryFor("ffgrep"), "listing");
		assert.equal(categoryFor("mcp_search"), "generic");
		assert.equal(hasRawTerminalOutput("\u001b[31mred\u001b[0m"), true);
		assert.equal(rtkToolName("bash"), "pi-bash");
	});
});

describe("select", () => {
	const cwd = "/workspace/repo";
	const big = "x".repeat(MIN_BYTES);

	it("enforces exclusions/MIN_BYTES and routes read (including pi-lens), bash file views, recall skips, listing, and generic", () => {
		assert.equal(select(makeEvent({ toolName: "edit" }), cwd), undefined);
		assert.equal(
			select(makeEvent({ toolName: "grep", parentToolCallId: "p1" }), cwd),
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
		// Multi-byte UTF-8: 171 * 3 = 513 bytes >= MIN_BYTES
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

		assert.deepEqual(
			select(
				makeEvent({
					toolName: "bash",
					input: { command: "cat src/a.ts" },
					content: [{ type: "text", text: big }],
				}),
				cwd,
			),
			{ category: "read", text: big, path: resolve(cwd, "src/a.ts") },
		);
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

		for (const recallCmd of [
			"rtk recall 0123456789abcdef",
			"cd /tmp && /usr/local/bin/rtk -v recall 0123456789abcdef --full",
			'echo "$(rtk recall 0123456789abcdef)"',
		]) {
			assert.equal(
				select(
					makeEvent({
						toolName: "bash",
						input: { command: recallCmd },
						content: [{ type: "text", text: big }],
					}),
					cwd,
				),
				undefined,
				recallCmd,
			);
		}
		assert.deepEqual(
			select(
				makeEvent({
					toolName: "bash",
					input: { command: 'echo "rtk recall deadbeef01234567"' },
				}),
				cwd,
			),
			{ category: "terminal", text: big },
		);
	});
});

describe("preservesTrailer, structureCheck, canCapListing & createGate", () => {
	const hint = "\n[full output: rtk recall 0123456789abcdef]";

	it("verifies trailer preservation across ANSI/CR, [xN] dedup, base64 elision, line caps, and Pi notices", () => {
		assert.equal(
			preservesTrailer("10%\r100%\r\n\u001b[32mPASS\u001b[0m\n", `PASS${hint}`),
			true,
		);
		assert.equal(preservesTrailer("a\nb\nb\nb", `a\nb\n[x3]${hint}`), true);
		assert.equal(preservesTrailer("a\nb\nb\nb", `a\nb\n[x2]${hint}`), false);

		const b64 = "A".repeat(1_024);
		assert.equal(
			preservesTrailer(
				`img=data:image/png;base64,${b64};end`,
				`img=[base64 image/png, 1024 chars elided];end${hint}`,
			),
			true,
		);
		assert.equal(
			preservesTrailer(
				`x=${"A".repeat(1_023)}!`,
				`x=[base64 data, 1023 chars elided]!${hint}`,
			),
			false,
		);

		const unicodeLine = `${"😀".repeat(10)}${"a".repeat(20)}`;
		assert.equal(
			preservesTrailer(unicodeLine, `${"😀".repeat(10)} [+20 chars]${hint}`),
			true,
		);
		assert.equal(
			preservesTrailer(unicodeLine, `${"😀".repeat(10)} [+19 chars]${hint}`),
			false,
		);

		const notice = "[Showing last 2000 lines. Full output: /tmp/pi-out.txt]";
		const withNotice = `body\n\n${notice}\n\nCommand exited with code 1`;
		assert.equal(
			preservesTrailer(
				withNotice,
				`short\n\n${notice}\n\nCommand exited with code 1${hint}`,
			),
			true,
		);
		assert.equal(
			preservesTrailer(
				withNotice,
				`short\n\nCommand exited with code 1${hint}`,
			),
			false,
		);
	});

	it("enforces listing boundaries in structureCheck/canCapListing and gates bundled/custom pipelines", () => {
		const check = structureCheck("listing");
		const multiFile = "src/a.ts\n 1: alpha\n\nsrc/b.ts\n 10: gamma";
		assert.equal(check(multiFile, "src/a.ts\n 1: alpha\n 10: gamma"), false);

		const multiMid = [
			"src/a.ts",
			...Array.from({ length: 79 }, (_, i) => ` ${i + 1}: hit`),
			"src/middle.ts",
			...Array.from({ length: 260 }, (_, i) => ` ${i + 1}: hit`),
		].join("\n");
		assert.equal(canCapListing(multiMid), false);
		assert.equal(canCapListing(makeFffSingleFile(350)), true);

		assert.equal(
			exceedsCap(
				Array.from({ length: 300 }, () => "a".repeat(2_000)).join("\n"),
			),
			false,
		);
		assert.equal(exceedsCap("a".repeat(2_001)), true);

		assert.deepEqual(ruleMethods(join(BUNDLED_RTK_ROOT, "terminal")), {
			kind: "methods",
			methods: ["ansi", "progress", "dedup", "base64-elide", "cap"],
		});

		const gate = createGate(BUNDLED_RTK_ROOT);
		assert.equal(gate("terminal", "normal line 1\nnormal line 2"), false);
		assert.equal(gate("terminal", "\u001b[32mok\u001b[0m"), true);
		assert.equal(gate("generic", "10%\r100%"), false);
		assert.equal(gate("listing", `\u001b[35m${multiMid}`), false);
		assert.equal(gate("listing", makeFffSingleFile(350)), true);

		const dir = mkdtempSync(join(tmpdir(), "rtk-gate-test-"));
		try {
			const listingDir = join(dir, "listing");
			mkdirSync(listingDir, { recursive: true });
			const tomlPath = join(listingDir, "pipeline.toml");
			writeFileSync(tomlPath, '[[hook.after_tool.any]]\nuse = ["ansi"]\n');
			const customGate = createGate(dir);
			assert.equal(customGate("listing", `\u001b[35m${multiMid}`), true);

			writeFileSync(
				tomlPath,
				'[[hook.after_tool.any]]\nuse = ["ansi", "cap"]\n',
			);
			const future = new Date(Date.now() + 60_000);
			utimesSync(tomlPath, future, future);
			assert.equal(customGate("listing", `\u001b[35m${multiMid}`), false);

			writeFileSync(tomlPath, "[[hook.after_tool.any]]\nenabled = false\n");
			assert.deepEqual(ruleMethods(listingDir), { kind: "disabled" });
			const futureDisabled = new Date(Date.now() + 120_000);
			utimesSync(tomlPath, futureDisabled, futureDisabled);
			assert.equal(customGate("listing", `\u001b[35m${multiMid}`), false);

			writeFileSync(
				tomlPath,
				'[[hook.after_tool.any]]\nuse = ["unknown-custom"]\n',
			);
			assert.deepEqual(ruleMethods(listingDir), { kind: "unsupported" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("worthReplacing / worthCondensing", () => {
	it("enforces MIN_SAVED_BYTES (128) and MIN_SAVED_RATIO (10%) using UTF-8 byte lengths", () => {
		const base = "a".repeat(300);
		assert.equal(worthReplacing(base, "a".repeat(300 - MIN_SAVED_BYTES)), true);
		assert.equal(
			worthReplacing(base, "a".repeat(300 - MIN_SAVED_BYTES + 1)),
			false,
		);
		assert.equal(worthReplacing("€".repeat(100), "€".repeat(57)), true);
		assert.equal(worthReplacing("€".repeat(100), "€".repeat(58)), false);

		assert.equal(worthCondensing("a".repeat(2_000), "a".repeat(1_850)), false);
		assert.equal(worthCondensing("a".repeat(2_000), "a".repeat(1_800)), true);
	});
});
