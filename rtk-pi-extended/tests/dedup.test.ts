import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
	ANY_START,
	type ContextResults,
	dedupPassages,
	dedupReadExcerpts,
	MIN_PASSAGE_BYTES,
	PassageIndex,
	passages,
	ReadIndex,
} from "../dedup.ts";
import type { ReadView } from "../views.ts";

function makeView(start: number, lines: string[]): ReadView {
	return { start, lines, body: lines.join("\n") };
}

function makeParagraph(tag: string, minBytes = MIN_PASSAGE_BYTES): string {
	const prefix = `[${tag}] `;
	const fillLen = Math.max(0, minBytes - Buffer.byteLength(prefix));
	return `${prefix}${"x".repeat(fillLen)}`;
}

function makeNumberedHunk(
	start: number,
	lines: readonly string[],
): string {
	return lines
		.map((line: string, index: number) => `${start + index}\t${line}`)
		.join("\n");
}

describe("ReadIndex", () => {
	it("finds exact and partial overlaps, rejecting disjoint ranges and mismatched lines", () => {
		const index = new ReadIndex();
		const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
		index.record("/repo/a.ts", "call-1", makeView(1, lines));

		// Exact match
		const exact = index.overlaps("/repo/a.ts", makeView(1, lines));
		assert.equal(exact.length, 1);
		assert.equal(exact[0]?.from, 1);
		assert.equal(exact[0]?.to, 10);
		assert.equal(exact[0]?.source.toolCallId, "call-1");

		// Partial overlap (new view starts in the middle and extends past end)
		const partial = index.overlaps(
			"/repo/a.ts",
			makeView(6, ["line-6", "line-7", "line-8", "line-9", "line-10", "line-11"]),
		);
		assert.equal(partial.length, 1);
		assert.equal(partial[0]?.from, 6);
		assert.equal(partial[0]?.to, 10);

		// Disjoint range
		assert.deepEqual(
			index.overlaps("/repo/a.ts", makeView(11, ["line-11", "line-12"])),
			[],
		);

		// Mismatched content in overlap region
		assert.deepEqual(
			index.overlaps("/repo/a.ts", makeView(5, ["line-5", "MODIFIED", "line-7"])),
			[],
		);

		// Different path
		assert.deepEqual(index.overlaps("/repo/other.ts", makeView(1, lines)), []);
	});

	it("orders overlaps by largest span first, then newest first on ties", () => {
		const index = new ReadIndex();
		const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);

		index.record("/repo/a.ts", "small-old", makeView(1, lines.slice(0, 4)));
		index.record("/repo/a.ts", "large-old", makeView(1, lines.slice(0, 8)));
		index.record("/repo/a.ts", "small-new", makeView(1, lines.slice(0, 4)));
		index.record("/repo/a.ts", "large-new", makeView(1, lines.slice(0, 8)));

		const overlaps = index.overlaps("/repo/a.ts", makeView(1, lines));
		assert.deepEqual(
			overlaps.map((o) => o.source.toolCallId),
			["large-new", "large-old", "small-new", "small-old"],
		);
	});

	it("tracks markReplaced, forcesFull, ANY_START, and clears covered ranges + requestedStart on record", () => {
		const index = new ReadIndex();
		const path = "/repo/a.ts";

		index.markReplaced(path, 50);
		index.markReplaced(path, 120);
		assert.equal(index.forcesFull(path, 50), true);
		assert.equal(index.forcesFull(path, 120), true);
		assert.equal(index.forcesFull(path, 1), false);
		assert.equal(index.forcesFull("/repo/b.ts", 50), false);

		// Widened read starting at 40 covering 40..60 with requestedStart=120
		// should clear 50 (in range) and 120 (requestedStart), while keeping outside starts.
		index.markReplaced(path, 200);
		index.record(
			path,
			"call-w",
			makeView(
				40,
				Array.from({ length: 21 }, (_, i) => `row-${40 + i}`),
			),
			120,
		);
		assert.equal(index.forcesFull(path, 40), false);
		assert.equal(index.forcesFull(path, 50), false);
		assert.equal(index.forcesFull(path, 120), false);
		assert.equal(index.forcesFull(path, 200), true);

		// ANY_START forces full for every start line until any verbatim record arrives.
		index.markReplaced(path, ANY_START);
		assert.equal(index.forcesFull(path, 1), true);
		assert.equal(index.forcesFull(path, 999), true);

		index.record(path, "call-clear", makeView(195, Array(10).fill("x")));
		assert.equal(index.forcesFull(path, 1), false);
		assert.equal(index.forcesFull(path, 200), false);
	});

	it("invalidates a single path without affecting other paths, and clear resets everything", () => {
		const index = new ReadIndex();
		index.record("/repo/a.ts", "a1", makeView(1, ["a"]));
		index.markReplaced("/repo/a.ts", 1);
		index.record("/repo/b.ts", "b1", makeView(1, ["b"]));
		index.markReplaced("/repo/b.ts", 1);

		index.invalidate("/repo/a.ts");
		assert.deepEqual(index.overlaps("/repo/a.ts", makeView(1, ["a"])), []);
		assert.equal(index.forcesFull("/repo/a.ts", 1), false);
		assert.equal(index.overlaps("/repo/b.ts", makeView(1, ["b"])).length, 1);
		assert.equal(index.forcesFull("/repo/b.ts", 1), true);

		index.clear();
		assert.deepEqual(index.overlaps("/repo/b.ts", makeView(1, ["b"])), []);
		assert.equal(index.forcesFull("/repo/b.ts", 1), false);
	});

	it("evicts oldest sources when total indexed characters exceed MAX_INDEXED_CHARS (16 MiB)", () => {
		const index = new ReadIndex();
		const chunk = "a".repeat(6 * 1024 * 1024); // 6 MiB each

		index.record("/repo/big.ts", "c1", makeView(1, [chunk]));
		index.record("/repo/big.ts", "c2", makeView(1, [chunk]));
		// 12 MiB total -> both retained.
		assert.deepEqual(
			index
				.overlaps("/repo/big.ts", makeView(1, [chunk]))
				.map((o) => o.source.toolCallId),
			["c2", "c1"],
		);

		// Adding a third 6 MiB read pushes total to 18 MiB > 16 MiB -> c1 evicted.
		index.record("/repo/big.ts", "c3", makeView(1, [chunk]));
		assert.deepEqual(
			index
				.overlaps("/repo/big.ts", makeView(1, [chunk]))
				.map((o) => o.source.toolCallId),
			["c3", "c2"],
		);
	});
});

describe("passages / PassageIndex / dedupPassages", () => {
	it("enforces the 256-byte UTF-8 floor on passages()", () => {
		const ascii255 = "a".repeat(255);
		const ascii256 = "a".repeat(256);
		// '€' is 3 UTF-8 bytes: 85 * 3 = 255 bytes, 86 * 3 = 258 bytes.
		const utf8_255 = "€".repeat(85);
		const utf8_258 = "€".repeat(86);

		assert.deepEqual(
			passages([ascii255, ascii256, utf8_255, utf8_258].join("\n\n")),
			[ascii256, utf8_258],
		);
	});

	it("scopes PassageIndex by tool, returns newest first, deduplicates call IDs, and supports clear", () => {
		const index = new PassageIndex();
		const p = makeParagraph("shared");

		index.record("bash", "c1", p);
		index.record("bash", "c2", p);
		index.record("bash", "c2", p); // duplicate ID not pushed twice
		index.record("grep", "g1", p);

		assert.deepEqual(index.calls("bash", p), ["c2", "c1"]);
		assert.deepEqual(index.calls("grep", p), ["g1"]);
		assert.deepEqual(index.calls("other", p), []);

		index.clear();
		assert.deepEqual(index.calls("bash", p), []);
	});

	it("evicts least-recently-used entries in PassageIndex past MAX_PASSAGES (50,000)", () => {
		const index = new PassageIndex();
		const pad = "z".repeat(250);
		const first = `p-000000-${pad}`;
		const second = `p-000001-${pad}`;

		// Insert 50,000 passages in batches of 500 per record() call for speed.
		const total = 50_000;
		const batchSize = 500;
		for (let start = 0; start < total; start += batchSize) {
			const batch: string[] = [];
			for (let i = start; i < start + batchSize; i++) {
				batch.push(`p-${String(i).padStart(6, "0")}-${pad}`);
			}
			index.record("bash", `batch-${start}`, batch.join("\n\n"));
		}

		// Touch `first` so it becomes most recently used, leaving `second` as oldest.
		index.record("bash", "refresh", first);
		// Insert one new passage to trigger LRU eviction of `second`.
		const newest = `p-newest-${pad}`;
		index.record("bash", "latest", newest);

		assert.deepEqual(index.calls("bash", second), []);
		assert.ok(index.calls("bash", first).includes("refresh"));
		assert.deepEqual(index.calls("bash", newest), ["latest"]);
	});

	it("omits repeated non-final passages while always keeping the final passage", () => {
		const index = new PassageIndex();
		const p1 = makeParagraph("p1");
		const p2 = makeParagraph("p2");
		const firstResult = `${p1}\n\n${p2}`;
		index.record("bash", "call-1", firstResult);

		const ctx: ContextResults = new Map([["call-1", firstResult]]);
		const res = dedupPassages("bash", `${p1}\n\n${p2}`, index, () => ctx);

		assert.equal(res.omitted, 1);
		assert.equal(
			res.text,
			`[rtk-pi-extended: 1 passage(s), ${Buffer.byteLength(p1)} bytes, omitted; identical text is in the bash result of tool call call-1 earlier in this conversation]\n\n${p2}`,
		);
	});

	it("coalesces consecutive unfenced passages from the same call and separates different calls", () => {
		const index = new PassageIndex();
		const p1 = makeParagraph("one");
		const p2 = makeParagraph("two");
		const p3 = makeParagraph("three");
		const tail = "final summary";

		const call1Text = `${p1}\n\n${p2}`;
		const call2Text = `${p2}\n\n${p3}`;
		index.record("bash", "call-1", call1Text);
		index.record("bash", "call-2", call2Text);

		const ctx: ContextResults = new Map([
			["call-1", call1Text],
			["call-2", call2Text],
		]);
		// p1 is only in call-1; p2 is in both call-1 and call-2, so p2 extends pending call-1!
		// p3 is only in call-2, so it flushes call-1 and starts a new marker for call-2.
		const res = dedupPassages(
			"bash",
			[p1, p2, p3, tail].join("\n\n"),
			index,
			() => ctx,
		);

		assert.equal(res.omitted, 3);
		assert.equal(
			res.text,
			[
				`[rtk-pi-extended: 2 passage(s), ${Buffer.byteLength(p1) + Buffer.byteLength(p2)} bytes, omitted; identical text is in the bash result of tool call call-1 earlier in this conversation]`,
				`[rtk-pi-extended: 1 passage(s), ${Buffer.byteLength(p3)} bytes, omitted; identical text is in the bash result of tool call call-2 earlier in this conversation]`,
				tail,
			].join("\n\n"),
		);
	});

	it("never coalesces across fence boundaries and preserves CommonMark fence balance", () => {
		const index = new PassageIndex();
		const plain = makeParagraph("plain");
		const fenced = makeParagraph("fenced");
		const tilde = makeParagraph("tilde");
		const indented = makeParagraph("indented");
		const nested = `\`\`\`\n${makeParagraph("nested")}\n\`\`\``;
		const crlfCore = makeParagraph("crlf");
		const end = "done";

		const doc = [
			plain,
			`\`\`\`ts\n${fenced}\n\`\`\``,
			`~~~py\n${tilde}\n~~~`,
			`   \`\`\`sh\n${indented}\n   \`\`\``,
			`\`\`\`\`md\n${nested}\n\`\`\`\``,
			`\`\`\`js\r\n${crlfCore}\n\`\`\`\r`,
			end,
		].join("\n\n");

		index.record("mcp", "c1", doc);
		const ctx: ContextResults = new Map([["c1", doc]]);
		const res = dedupPassages("mcp", doc, index, () => ctx);

		assert.equal(res.omitted, 6);
		const parts = res.text.split("\n\n");
		assert.equal(parts.length, 7);
		assert.ok(parts[0]?.startsWith("[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[1]?.startsWith("```ts\n[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[1]?.endsWith("\n```"));
		assert.ok(parts[2]?.startsWith("~~~py\n[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[2]?.endsWith("\n~~~"));
		assert.ok(parts[3]?.startsWith("   ```sh\n[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[3]?.endsWith("\n   ```"));
		assert.ok(parts[4]?.startsWith("````md\n[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[4]?.endsWith("\n````"));
		assert.ok(parts[5]?.startsWith("```js\r\n[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[5]?.endsWith("\n```\r"));
		assert.equal(parts[6], end);
	});

	it("handles multi-paragraph fenced blocks, balanced inner fences, and skips unbalanced fences", () => {
		const index = new PassageIndex();
		const openBody = makeParagraph("open-body");
		const midBody = makeParagraph("mid-body");
		const closeBody = makeParagraph("close-body");
		const multiFenced = [
			`\`\`\`ts\n${openBody}`,
			midBody,
			`${closeBody}\n\`\`\``,
			"tail",
		].join("\n\n");

		index.record("mcp", "c1", multiFenced);
		const ctx: ContextResults = new Map([["c1", multiFenced]]);
		const res = dedupPassages("mcp", multiFenced, index, () => ctx);

		assert.equal(res.omitted, 3);
		const parts = res.text.split("\n\n");
		assert.equal(parts.length, 4);
		assert.ok(parts[0]?.startsWith("```ts\n[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[1]?.startsWith("[rtk-pi-extended: 1 passage(s),"));
		assert.ok(parts[2]?.endsWith("\n```"));
		assert.equal(parts[3], "tail");

		// Balanced paragraph containing a complete inner fence can be omitted as a unit.
		const innerBalanced = `intro\n\`\`\`ts\n${makeParagraph("inner")}\n\`\`\`\noutro`;
		const balancedDoc = `${innerBalanced}\n\ntail`;
		index.record("mcp", "c-bal", balancedDoc);
		const ctxBal: ContextResults = new Map([["c-bal", balancedDoc]]);
		const resBal = dedupPassages("mcp", balancedDoc, index, () => ctxBal);
		assert.equal(resBal.omitted, 1);

		// Unbalanced mid-paragraph opening fence must never be omitted.
		const unbalanced = `intro\n\`\`\`ts\n${makeParagraph("unbalanced")}\n\ntail`;
		index.record("mcp", "c2", unbalanced);
		const ctx2: ContextResults = new Map([["c2", unbalanced]]);
		const res2 = dedupPassages("mcp", unbalanced, index, () => ctx2);
		assert.equal(res2.omitted, 0);
		assert.equal(res2.text, unbalanced);
	});

	it("respects context visibility and falls back to an older visible call", () => {
		const index = new PassageIndex();
		const p = makeParagraph("visible-check");
		const doc = `${p}\n\nfooter`;

		index.record("bash", "old-visible", doc);
		index.record("bash", "new-compacted", doc);

		// Newest call was evicted from context; should fall back to old-visible.
		const ctx1: ContextResults = new Map([["old-visible", doc]]);
		const res1 = dedupPassages("bash", doc, index, () => ctx1);
		assert.equal(res1.omitted, 1);
		assert.ok(res1.text.includes("tool call old-visible"));

		// Neither call is visible in context -> nothing omitted.
		const ctxEmpty: ContextResults = new Map([["old-visible", "unrelated"]]);
		const res2 = dedupPassages("bash", doc, index, () => ctxEmpty);
		assert.equal(res2.omitted, 0);
		assert.equal(res2.text, doc);
	});
});

describe("dedupReadExcerpts", () => {
	const cwd = "/workspace/repo";
	const fileLines = Array.from(
		{ length: 20 },
		(_, i) => `const value_${i + 1} = "${"v".repeat(30)}";`,
	);
	const fullView = makeView(1, fileLines);

	it("deduplicates single and multiple hunks under one file heading", () => {
		const reads = new ReadIndex();
		reads.record(resolve(cwd, "src/app.ts"), "read-1", fullView);
		const ctx: ContextResults = new Map([["read-1", fullView.body]]);

		const hunk1 = makeNumberedHunk(1, fileLines.slice(0, 8));
		const hunk2 = makeNumberedHunk(11, fileLines.slice(10, 18));
		const input = [
			"**`src/app.ts`**",
			`\`\`\`ts\n${hunk1}\n\`\`\``,
			`\`\`\`ts\n${hunk2}\n\`\`\``,
		].join("\n\n");

		const res = dedupReadExcerpts(input, cwd, reads, () => ctx);
		assert.equal(res.omitted, 2);
		assert.equal(
			res.text,
			[
				"**`src/app.ts`**",
				"```ts\n[rtk-pi-extended: lines 1-8 omitted; identical text is in the read result of tool call read-1 earlier in this conversation]\n```",
				"```ts\n[rtk-pi-extended: lines 11-18 omitted; identical text is in the read result of tool call read-1 earlier in this conversation]\n```",
			].join("\n\n"),
		);
	});

	it("clears currentPath on intervening prose so following fenced hunks are kept", () => {
		const reads = new ReadIndex();
		reads.record(resolve(cwd, "src/app.ts"), "read-1", fullView);
		const ctx: ContextResults = new Map([["read-1", fullView.body]]);

		const hunk = makeNumberedHunk(1, fileLines.slice(0, 8));
		const input = [
			"**`src/app.ts`**",
			"Some explanatory prose that clears currentPath.",
			`\`\`\`ts\n${hunk}\n\`\`\``,
		].join("\n\n");

		const res = dedupReadExcerpts(input, cwd, reads, () => ctx);
		assert.equal(res.omitted, 0);
		assert.equal(res.text, input);
	});

	it("clears currentPath when a multi-paragraph fenced hunk closes", () => {
		const reads = new ReadIndex();
		reads.record(resolve(cwd, "src/app.ts"), "read-1", fullView);
		const ctx: ContextResults = new Map([["read-1", fullView.body]]);

		const firstHalf = makeNumberedHunk(1, fileLines.slice(0, 8));
		const secondHalf = makeNumberedHunk(9, fileLines.slice(8, 16));
		const followUp = makeNumberedHunk(1, fileLines.slice(0, 8));
		const input = [
			"**`src/app.ts`**",
			`\`\`\`ts\n${firstHalf}`,
			`${secondHalf}\n\`\`\``,
			// After multi-paragraph fence closes, currentPath is cleared!
			`\`\`\`ts\n${followUp}\n\`\`\``,
		].join("\n\n");

		const res = dedupReadExcerpts(input, cwd, reads, () => ctx);
		assert.equal(res.omitted, 2);
		const parts = res.text.split("\n\n");
		assert.ok(parts[1]?.includes("lines 1-8 omitted"));
		assert.ok(parts[2]?.includes("lines 9-16 omitted"));
		// Third hunk remains verbatim because currentPath cleared on close.
		assert.equal(parts[3], `\`\`\`ts\n${followUp}\n\`\`\``);
	});

	it("supports tilde fences and 3-space indented fences", () => {
		const reads = new ReadIndex();
		reads.record(resolve(cwd, "src/app.ts"), "read-1", fullView);
		const ctx: ContextResults = new Map([["read-1", fullView.body]]);

		const hunk = makeNumberedHunk(1, fileLines.slice(0, 8));
		const input = [
			"**`src/app.ts`**",
			`~~~ts\n${hunk}\n~~~`,
			`   \`\`\`ts\n${hunk}\n   \`\`\``,
		].join("\n\n");

		const res = dedupReadExcerpts(input, cwd, reads, () => ctx);
		assert.equal(res.omitted, 2);
		assert.ok(res.text.includes("~~~ts\n[rtk-pi-extended: lines 1-8 omitted"));
		assert.ok(
			res.text.includes("   ```ts\n[rtk-pi-extended: lines 1-8 omitted"),
		);
	});

	it("skips mismatched content, non-contiguous line numbers, line 0, short hunks, and partial overlaps", () => {
		const reads = new ReadIndex();
		// Record only lines 1..10
		const partialRead = makeView(1, fileLines.slice(0, 10));
		reads.record(resolve(cwd, "src/app.ts"), "read-1", partialRead);
		const ctx: ContextResults = new Map([["read-1", partialRead.body]]);

		// Mismatched line
		const badLines = [...fileLines.slice(0, 8)];
		badLines[3] = "DIFFERENT";
		const mismatched = makeNumberedHunk(1, badLines);

		// Non-contiguous line numbers (1, 2, 4, ...)
		const nonContiguous = [
			`1\t${fileLines[0]}`,
			`2\t${fileLines[1]}`,
			...fileLines.slice(3, 10).map((l, i) => `${i + 4}\t${l}`),
		].join("\n");

		// Line number < 1
		const zeroLine = makeNumberedHunk(0, fileLines.slice(0, 8));

		// Short hunk (< 256 bytes)
		const shortHunk = makeNumberedHunk(1, fileLines.slice(0, 2));

		// Hunk extends beyond recorded read (lines 5..15, read only has 1..10)
		const beyondRead = makeNumberedHunk(5, fileLines.slice(4, 15));

		for (const hunk of [
			mismatched,
			nonContiguous,
			zeroLine,
			shortHunk,
			beyondRead,
		]) {
			const input = `**\`src/app.ts\`**\n\n\`\`\`ts\n${hunk}\n\`\`\``;
			const res = dedupReadExcerpts(input, cwd, reads, () => ctx);
			assert.equal(res.omitted, 0);
			assert.equal(res.text, input);
		}
	});

	it("checks context visibility and ignores headings appearing inside open fences", () => {
		const reads = new ReadIndex();
		reads.record(resolve(cwd, "src/app.ts"), "read-old", fullView);
		reads.record(resolve(cwd, "src/app.ts"), "read-new", fullView);

		const hunk = makeNumberedHunk(1, fileLines.slice(0, 8));
		const input = `**\`src/app.ts\`**\n\n\`\`\`ts\n${hunk}\n\`\`\``;

		// Only read-old is visible -> picks read-old.
		const ctxOld: ContextResults = new Map([["read-old", fullView.body]]);
		const resOld = dedupReadExcerpts(input, cwd, reads, () => ctxOld);
		assert.equal(resOld.omitted, 1);
		assert.ok(resOld.text.includes("tool call read-old"));

		// Neither read visible -> skipped.
		const ctxNone: ContextResults = new Map();
		const resNone = dedupReadExcerpts(input, cwd, reads, () => ctxNone);
		assert.equal(resNone.omitted, 0);
		assert.equal(resNone.text, input);

		// A heading inside an open fence must not set currentPath.
		const fencedHeading = [
			"```md",
			"**`src/app.ts`**",
			"```",
			`\`\`\`ts\n${hunk}\n\`\`\``,
		].join("\n\n");
		const resFenced = dedupReadExcerpts(
			fencedHeading,
			cwd,
			reads,
			() => ctxOld,
		);
		assert.equal(resFenced.omitted, 0);
		assert.equal(resFenced.text, fencedHeading);
	});
});
