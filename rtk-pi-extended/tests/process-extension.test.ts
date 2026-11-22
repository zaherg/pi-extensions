import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Result } from "../bridge.ts";
import { unfactorSuffixes } from "../compact.ts";
import { type ContextResults, PassageIndex, ReadIndex } from "../dedup.ts";
import { createGate } from "../gate.ts";
import rtkPiExtended from "../index.ts";
import { ENTRY_TYPE, parseEntry } from "../outcomes.ts";
import { type Call, type Dependencies, processRoute } from "../process.ts";

const RTK_PIPELINES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"rtk",
);

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

function makeDeps(overrides: Partial<Dependencies> = {}): {
	deps: Dependencies;
	reads: ReadIndex;
	passages: PassageIndex;
	visible: Map<string, string>;
} {
	const reads = overrides.reads ?? new ReadIndex();
	const passages = overrides.passages ?? new PassageIndex();
	const visible = new Map<string, string>();
	const deps: Dependencies = {
		cwd: "/repo",
		gate: () => false,
		rtk: async (): Promise<Result> => ({ kind: "unchanged" }),
		context: (): ContextResults => visible,
		reads,
		passages,
		...overrides,
	};
	return { deps, reads, passages, visible };
}

function makeLines(from: number, to: number, prefix = "line"): string[] {
	const out: string[] = [];
	for (let i = from; i <= to; i++) {
		out.push(
			`${prefix} ${String(i).padStart(3, "0")}: ${"abcdefghij".repeat(3)}`,
		);
	}
	return out;
}

function makeCall(
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown> = {},
): Call {
	return { toolName, toolCallId, input };
}

after(async () => {
	await Promise.all(
		tempRoots.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("processRoute — read category", () => {
	it("deduplicates exact & partial overlaps, handles shrunk EOFs, and honors pi-lens read-forced retries", async () => {
		const { deps, visible } = makeDeps();
		const notice = "[Showing lines 1-30 of 200. Use offset=31 to continue.]";
		const lines50 = makeLines(1, 50);
		const body30 = lines50.slice(0, 30).join("\n");
		const full30 = `${body30}\n\n${notice}`;

		const first = await processRoute(
			{ category: "read", path: "/repo/src/app.ts", text: full30 },
			makeCall("read", "read-1", { path: "src/app.ts", offset: 1 }),
			deps,
		);
		assert.equal(first?.text, undefined);
		visible.set("read-1", full30);

		const exact = await processRoute(
			{ category: "read", path: "/repo/src/app.ts", text: full30 },
			makeCall("read", "read-2", { path: "src/app.ts", offset: 1 }),
			deps,
		);
		assert.equal(exact?.sample.mechanism, "read-dedup");
		assert.ok(exact?.text?.endsWith(`\n\n${notice}`));

		// Partial overlap on a fresh range (lines 15-39 recorded, then lines 1-50 read)
		const { deps: pDeps, visible: pVis } = makeDeps();
		const midBody = lines50.slice(14, 39).join("\n");
		await processRoute(
			{
				category: "read",
				path: "/repo/src/mid.ts",
				text: midBody,
				offset: 15,
			},
			makeCall("read", "read-mid", { path: "src/mid.ts", offset: 15 }),
			pDeps,
		);
		pVis.set("read-mid", midBody);

		const full50 = lines50.join("\n");
		const partial = await processRoute(
			{ category: "read", path: "/repo/src/mid.ts", text: full50 },
			makeCall("read", "read-full", { path: "src/mid.ts", offset: 1 }),
			pDeps,
		);
		assert.equal(partial?.sample.mechanism, "read-dedup");
		assert.ok(partial?.text?.includes("lines 15-39 omitted"));
		assert.ok(partial?.text?.includes(lines50[0] ?? ""));
		assert.ok(partial?.text?.includes(lines50[49] ?? ""));

		// Unbounded read after file shrinks to 20 lines (no limit, no notice) evicts 50-line source
		const { deps: sDeps, visible: sVis } = makeDeps();
		await processRoute(
			{ category: "read", path: "/repo/src/shrink.ts", text: full50 },
			makeCall("read", "read-50", { path: "src/shrink.ts" }),
			sDeps,
		);
		sVis.set("read-50", full50);
		const shrunkRes = await processRoute(
			{
				category: "read",
				path: "/repo/src/shrink.ts",
				text: lines50.slice(0, 20).join("\n"),
			},
			makeCall("read", "read-shrunk", { path: "src/shrink.ts" }),
			sDeps,
		);
		assert.equal(shrunkRes?.text, undefined);

		// Widened pi-lens retry forces full delivery once, then resumes dedup
		const { deps: wDeps, visible: wVis } = makeDeps();
		const wPath = "/repo/src/widened.ts";
		const wBody = lines50.slice(9, 45).join("\n");
		await processRoute(
			{ category: "read", path: wPath, text: wBody, offset: 10 },
			makeCall("read", "w1", { path: "src/widened.ts", offset: 10 }),
			wDeps,
		);
		wVis.set("w1", wBody);

		const wDedup = await processRoute(
			{ category: "read", path: wPath, text: wBody, offset: 10, blockIndex: 1 },
			makeCall("read", "w2", { path: "src/widened.ts", offset: 20 }),
			wDeps,
		);
		assert.equal(wDedup?.sample.mechanism, "read-dedup");

		const wRetry = await processRoute(
			{ category: "read", path: wPath, text: wBody, offset: 10, blockIndex: 1 },
			makeCall("read", "w3", { path: "src/widened.ts", offset: 20 }),
			wDeps,
		);
		assert.equal(wRetry?.text, undefined);
		assert.equal(wRetry?.sample.mechanism, "read-forced");
	});

	it("condenses lockfiles, minified lines, partial/bash JSON, and marks whole-path replacement on bash file views", async () => {
		const { deps, reads } = makeDeps();
		const packages = Array.from({ length: 10 }, (_, i) =>
			[
				`    "node_modules/pkg-${i}": {`,
				`      "version": "1.${i}.0",`,
				`      "integrity": "sha512-${"A".repeat(88)}"`,
				"    },",
			].join("\n"),
		).join("\n");
		const lockPath = "/repo/package-lock.json";
		const lockText = `{\n  "packages": {\n${packages}\n  }\n}`;

		const bashLock = await processRoute(
			{ category: "read", path: lockPath, text: lockText },
			makeCall("bash", "b-lock", { command: "cat package-lock.json" }),
			deps,
		);
		assert.equal(bashLock?.sample.mechanism, "lockfile-summary");
		assert.equal(reads.forcesFull(lockPath, 1), true);
		assert.equal(reads.forcesFull(lockPath, 77), true);

		const minRes = await processRoute(
			{
				category: "read",
				path: "/repo/dist/app.min.js",
				text: `${"a".repeat(299)}🚀${"b".repeat(500)}`,
			},
			makeCall("read", "min-1", { path: "dist/app.min.js" }),
			deps,
		);
		assert.equal(minRes?.sample.mechanism, "long-line-trim");
		assert.equal(minRes?.text?.isWellFormed(), true);

		const bigJson = Array.from(
			{ length: 400 },
			(_, i) => `        "key_${i}": "${"x".repeat(30)}",`,
		).join("\n");
		assert.ok(Buffer.byteLength(bigJson) > 16 * 1024);
		assert.equal(
			(
				await processRoute(
					{ category: "read", path: "/repo/full.json", text: bigJson },
					makeCall("read", "j-full", { path: "full.json" }),
					deps,
				)
			)?.text,
			undefined,
		);
		const partialJson = await processRoute(
			{
				category: "read",
				path: "/repo/part.json",
				text: `${bigJson}\n\n[Showing lines 1-400 of 900. Use offset=401 to continue.]`,
			},
			makeCall("read", "j-part", { path: "part.json" }),
			deps,
		);
		assert.equal(partialJson?.sample.mechanism, "json-indent");
	});
});

describe("processRoute — terminal, listing & generic categories", () => {
	it("runs dedupPassages BEFORE factorSuffixes (preventing cross-turn [^1] collisions) and skips clean wrapped commands", async () => {
		const { deps, passages, visible } = makeDeps();
		const suffix1 =
			" --target=x86_64-unknown-linux-gnu --release --features=full-telemetry-v1";
		const suffix2 =
			" --target=aarch64-apple-darwin-gnu --debug   --features=minimal-local-v2";

		const makeFactorable = (suffix: string): string =>
			Array.from({ length: 6 }, (_, i) => `compiling crate_${i}${suffix}`).join(
				"\n",
			);
		const sharedBanner = Array.from(
			{ length: 6 },
			(_, i) =>
				`diagnostic banner ${i}: ${String.fromCharCode(97 + i).repeat(42)} [end-${i}]`,
		).join("\n");

		const p1 = makeFactorable(suffix1);
		const res1 = await processRoute(
			{ category: "terminal", text: `${sharedBanner}\n\n${p1}\n\ndone 1` },
			makeCall("bash", "t1", { command: "cargo build" }),
			deps,
		);
		assert.ok(res1?.text);
		assert.equal(res1.sample.mechanism, "suffix-factor");
		assert.deepEqual(passages.calls("bash", p1), ["t1"]);
		visible.set("t1", res1.text);

		const p2 = makeFactorable(suffix2);
		const res2 = await processRoute(
			{ category: "terminal", text: `${sharedBanner}\n\n${p2}\n\ndone 2` },
			makeCall("bash", "t2", { command: "cargo build --debug" }),
			deps,
		);
		assert.ok(res2?.text);
		assert.equal(res2.sample.mechanism, "passage-dedup+suffix-factor");
		assert.ok(res2.text.includes(`[^1]:${suffix2}`));
		assert.equal(res2.text.includes(suffix1), false);
		assert.ok(unfactorSuffixes(res2.text).includes(p2));

		// Wrapped clean command skips RTK
		let rtkCalls = 0;
		const { deps: wDeps } = makeDeps({
			gate: () => true,
			rtk: async () => {
				rtkCalls++;
				return { kind: "unchanged" };
			},
		});
		assert.equal(
			await processRoute(
				{
					category: "terminal",
					text: "clean wrapped line\n".repeat(40),
					wrapped: true,
				},
				makeCall("bash", "w1", { command: "rtk git status" }),
				wDeps,
			),
			undefined,
		);
		assert.equal(rtkCalls, 0);
	});

	it("enforces single-vs-multi-file FFF cap in listing and chains excerpt+passage+suffix in generic", async () => {
		let rtkCalls = 0;
		const { deps: listDeps } = makeDeps({
			gate: createGate(RTK_PIPELINES_DIR),
			rtk: async (_tool, text) => {
				rtkCalls++;
				const lines = text.split("\n");
				return {
					kind: "filtered",
					text: `${[...lines.slice(0, 50), "[... elided ...]", ...lines.slice(-200)].join("\n")}\n[full output: rtk recall 0123456789abcdef]`,
				};
			},
		});

		const multiSections: string[] = [];
		for (let f = 0; f < 18; f++) {
			multiSections.push(`src/mod-${f}/file.ts`);
			for (let line = 1; line <= 20; line++) {
				multiSections.push(` ${line}: match ${line}`);
			}
			multiSections.push("");
		}
		assert.equal(
			(
				await processRoute(
					{ category: "listing", text: multiSections.join("\n") },
					makeCall("ffgrep", "fff-multi"),
					listDeps,
				)
			)?.text,
			undefined,
		);
		assert.equal(rtkCalls, 0);

		const singleFileFff = [
			"src/huge.ts",
			...Array.from({ length: 350 }, (_, i) => ` ${i + 1}: const v = ${i};`),
		].join("\n");
		const singleRes = await processRoute(
			{ category: "listing", text: singleFileFff },
			makeCall("ffgrep", "fff-single"),
			listDeps,
		);
		assert.equal(rtkCalls, 1);
		assert.equal(singleRes?.sample.mechanism, "rtk:listing");

		// Generic: excerpt-dedup + passage-dedup + suffix-factor
		const { deps, reads, passages, visible } = makeDeps();
		const linesA = makeLines(1, 15, "alpha");
		reads.record("/repo/src/a.ts", "read-a", {
			start: 1,
			lines: linesA,
			body: linesA.join("\n"),
		});
		visible.set("read-a", linesA.join("\n"));

		const prevPassage = Array.from(
			{ length: 6 },
			(_, i) => `MCP explanation line ${i} ${"p".repeat(35)}`,
		).join("\n");
		passages.record("mcp_search", "mcp-prev", `${prevPassage}\n\nfooter`);
		visible.set("mcp-prev", `${prevPassage}\n\nfooter`);

		const hunkA = linesA
			.slice(0, 10)
			.map((l, i) => `${i + 1}\t${l}`)
			.join("\n");
		const suffix =
			" -> resolved via symbol table cache hit in workspace package index";
		const factorBlock = Array.from(
			{ length: 5 },
			(_, i) => `ref_${i}${suffix}`,
		).join("\n");
		const genericRes = await processRoute(
			{
				category: "generic",
				text: [
					"**`src/a.ts`**",
					`\`\`\`ts\n${hunkA}\n\`\`\``,
					prevPassage,
					factorBlock,
					"summary",
				].join("\n\n"),
			},
			makeCall("mcp_search", "mcp-1"),
			deps,
		);
		assert.equal(
			genericRes?.sample.mechanism,
			"excerpt-dedup+passage-dedup+suffix-factor",
		);
	});
});

describe("rtk-pi-extended/index.ts — extension hooks", () => {
	it("rewrites tool_result, invalidates ReadIndex only on non-error edit/write, records turn_end ledger, and honors RTK_DISABLED=1", async () => {
		const sessionDir = await makeTempDir("rtk-ext-");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const projection: Array<{
			role: "toolResult";
			toolCallId: string;
			content: Array<{ type: "text"; text: string }>;
		}> = [];
		let leafId = "leaf-0";

		rtkPiExtended({
			on(event: string, fn: (...args: unknown[]) => unknown): void {
				handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			},
			registerCommand(): void {},
			async exec() {
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		} as unknown as ExtensionAPI);

		const ctx = {
			cwd: "/repo",
			hasUI: true,
			ui: { notify(): void {} },
			sessionManager: {
				getLeafId: () => leafId,
				getSessionDir: () => sessionDir,
				buildSessionProjection: () => ({ messages: projection }),
			},
		} as unknown as ExtensionContext;

		const emitTool = async (
			partial: Partial<ToolResultEvent> & {
				toolName: string;
				toolCallId: string;
				content: ToolResultEvent["content"];
			},
		) => {
			const [fn] = handlers.get("tool_result") ?? [];
			assert.ok(fn);
			return (await fn(
				{
					type: "tool_result",
					input: {},
					isError: false,
					...partial,
				} as ToolResultEvent,
				ctx,
			)) as ToolResultEventResult | undefined;
		};

		const emitTurnEnd = () => {
			const [fn] = handlers.get("turn_end") ?? [];
			assert.ok(fn);
			return fn({ type: "turn_end", entries: [] } as unknown as TurnEndEvent) as
				| TurnEndEventResult
				| undefined;
		};

		const body = makeLines(1, 30).join("\n");
		assert.equal(
			await emitTool({
				toolName: "read",
				toolCallId: "r1",
				input: { path: "src/f.ts" },
				content: [{ type: "text", text: body }],
			}),
			undefined,
		);
		projection.push({
			role: "toolResult",
			toolCallId: "r1",
			content: [{ type: "text", text: body }],
		});
		leafId = "leaf-1";

		// Errored edit does NOT invalidate ReadIndex
		await emitTool({
			toolName: "edit",
			toolCallId: "e-err",
			input: { path: "src/f.ts" },
			isError: true,
			content: [{ type: "text", text: "no match" }],
		});
		const deduped = await emitTool({
			toolName: "read",
			toolCallId: "r2",
			input: { path: "src/f.ts" },
			content: [{ type: "text", text: body }],
		});
		assert.ok(deduped?.content);

		// Successful edit invalidates ReadIndex
		await emitTool({
			toolName: "edit",
			toolCallId: "e-ok",
			input: { path: "src/f.ts" },
			isError: false,
			content: [{ type: "text", text: "edited" }],
		});
		assert.equal(
			await emitTool({
				toolName: "read",
				toolCallId: "r3",
				input: { path: "src/f.ts" },
				content: [{ type: "text", text: body }],
			}),
			undefined,
		);

		// turn_end drains valid ENTRY_TYPE custom entry
		const turn = emitTurnEnd();
		const entry = turn?.entries?.[0] as
			| { type: string; customType: string; data: unknown }
			| undefined;
		assert.equal(entry?.customType, ENTRY_TYPE);
		assert.ok(parseEntry(entry?.data));

		// RTK_DISABLED=1 bypasses filtering
		const prev = process.env.RTK_DISABLED;
		process.env.RTK_DISABLED = "1";
		try {
			const grepOut = Array.from(
				{ length: 20 },
				(_, i) => `src/long/path/module.ts:${i + 1}: hit(${i});`,
			).join("\n");
			assert.equal(
				await emitTool({
					toolName: "grep",
					toolCallId: "g1",
					input: { pattern: "hit" },
					content: [{ type: "text", text: grepOut }],
				}),
				undefined,
			);
		} finally {
			if (prev === undefined) delete process.env.RTK_DISABLED;
			else process.env.RTK_DISABLED = prev;
		}
	});
});
