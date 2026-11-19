import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE, parseEntry } from "../outcomes.ts";

// End to end through Pi's real extension loader and agent loop, with the stock
// RTK Pi hook and a scripted model. Requires an installed Pi package.
const PI_PACKAGE_ROOT = process.env.PI_PACKAGE_ROOT;
const STOCK_HOOK =
	process.env.RTK_PI_HOOK ??
	join(homedir(), ".pi", "agent", "extensions", "rtk.ts");
const skip = !PI_PACKAGE_ROOT
	? "Set PI_PACKAGE_ROOT to the installed Pi package."
	: !existsSync(STOCK_HOOK)
		? "Install RTK's Pi hook or set RTK_PI_HOOK to its path."
		: false;

type Pi = typeof import("@earendil-works/pi-coding-agent");
type Model = NonNullable<
	NonNullable<Parameters<Pi["createAgentSession"]>[0]>["model"]
>;
// The `(name, config)` overload; Pi does not export the config type itself.
type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
// The subset of pi-ai's test provider this file uses.
interface Faux {
	createFauxCore(options: {
		provider: string;
		api: string;
		models: { id: string }[];
	}): {
		api: string;
		streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
		getModel(): Model;
		setResponses(responses: unknown[]): void;
	};
	fauxAssistantMessage(content: unknown): unknown;
	fauxToolCall(
		name: string,
		args: Record<string, unknown>,
		options: { id: string },
	): unknown;
}

const RECALL_HINT = /\n\[full output: rtk recall [a-f0-9]{16}\]$/;
const LOOP =
	'for i in $(seq 1 400); do echo "step $i: compiled module $i"; done';

function resolveFauxPath(piRoot: string): string {
	// Support both nested and hoisted `@earendil-works/pi-ai` layouts.
	const nested = join(
		piRoot,
		"node_modules",
		"@earendil-works",
		"pi-ai",
		"dist",
		"providers",
		"faux.js",
	);
	const hoisted = join(piRoot, "..", "pi-ai", "dist", "providers", "faux.js");
	return existsSync(nested) ? nested : hoisted;
}

test("filters only output the stock RTK hook did not rewrite", {
	skip,
}, async (t) => {
	const root = String(PI_PACKAGE_ROOT);
	const pi: Pi = await import(
		pathToFileURL(join(root, "dist", "index.js")).href
	);
	const faux: Faux = await import(pathToFileURL(resolveFauxPath(root)).href);

	const home = mkdtempSync(join(tmpdir(), "rtk-pi-session-"));
	const saved = { ...process.env };
	Object.assign(process.env, {
		HOME: home,
		XDG_DATA_HOME: join(home, "data"),
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_CACHE_HOME: join(home, "cache"),
	});
	delete process.env.RTK_DISABLED;
	t.after(() => {
		for (const key of Object.keys(process.env))
			if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(home, { recursive: true, force: true });
	});
	const cwd = join(home, "project");
	const agentDir = join(home, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(
		join(cwd, "big.txt"),
		Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n"),
	);

	const core = faux.createFauxCore({
		provider: "faux",
		api: "faux-api",
		models: [{ id: "faux-1" }],
	});
	const read = (id: string, args: Record<string, unknown> = {}) =>
		faux.fauxAssistantMessage([
			faux.fauxToolCall("read", { path: "big.txt", ...args }, { id }),
		]);
	core.setResponses([
		faux.fauxAssistantMessage([
			faux.fauxToolCall("bash", { command: LOOP }, { id: "loop" }),
			faux.fauxToolCall("bash", { command: "cat big.txt" }, { id: "cat" }),
		]),
		read("first"),
		read("repeat"),
		read("forced"),
		faux.fauxAssistantMessage([
			faux.fauxToolCall(
				"edit",
				{
					path: "big.txt",
					edits: [{ oldText: "row 5\n", newText: "row five\n" }],
				},
				{ id: "edit" },
			),
		]),
		read("after-edit"),
		read("range", { offset: 100, limit: 200 }),
		faux.fauxAssistantMessage("done"),
	]);
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [
			STOCK_HOOK,
			fileURLToPath(new URL("../index.ts", import.meta.url)),
		],
		extensionFactories: [
			(api: ExtensionAPI) => {
				api.registerProvider("faux", {
					baseUrl: "http://127.0.0.1:9",
					apiKey: "unused",
					api: core.api,
					streamSimple: core.streamSimple,
					models: [
						{
							id: "faux-1",
							name: "Faux",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100_000,
							maxTokens: 4_096,
						},
					],
				});
			},
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		sessionManager: pi.SessionManager.inMemory(cwd),
		model: core.getModel(),
		tools: ["bash", "read", "edit"],
	});
	t.after(() => session.dispose());
	assert.equal(session.model?.provider, "faux");
	await session.prompt("run the build");

	const entries = session.sessionManager.getEntries();
	const results = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult")
			continue;
		const block = entry.message.content[0];
		results.set(
			entry.message.toolCallId,
			block?.type === "text" ? block.text : "",
		);
	}
	const loop = results.get("loop") ?? "";
	assert.match(loop, RECALL_HINT, "raw command output was filtered");
	assert.match(loop, /\n\[\d+ lines elided\]\n/);
	// The command's trailing newline survives, so a blank line precedes the hint.
	assert.ok(
		loop.replace(RECALL_HINT, "").endsWith("step 400: compiled module 400\n"),
	);
	// The stock hook rewrote `cat` to `rtk read`: a file view of code, left byte-exact.
	const cat = results.get("cat") ?? "";
	assert.doesNotMatch(cat, RECALL_HINT);
	assert.ok(cat.includes("row 200"));

	const file = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n");
	assert.equal(results.get("first"), file);
	const stub = results.get("repeat") ?? "";
	assert.match(
		stub,
		/^\[rtk-pi-extended\] Unchanged: lines 1-400 of big\.txt are identical to the read result of tool call first,/,
	);
	// Reading a replaced range again returns the exact text.
	assert.equal(results.get("forced"), file);
	// After the edit the file differs, so the next read is complete.
	const edited = file.replace("row 5\n", "row five\n");
	assert.equal(results.get("after-edit"), edited);
	// A range inside the post-edit read points back at it, keeping Pi's continuation notice.
	const range = results.get("range") ?? "";
	assert.match(
		range,
		/^\[rtk-pi-extended\] Unchanged: lines 100-299 of big\.txt are identical to the read result of tool call after-edit,/,
	);
	assert.ok(
		range.endsWith("\n\n[101 more lines in file. Use offset=300 to continue.]"),
	);

	const totals = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = parseEntry(entry.data);
		assert.ok(data, "outcome entries are valid");
		for (const tally of data.tallies) {
			const key = [
				tally.tool,
				tally.category,
				tally.mechanism,
				tally.outcome,
			].join(" ");
			totals.set(key, (totals.get(key) ?? 0) + tally.count);
		}
	}
	assert.deepEqual(Object.fromEntries([...totals].sort()), {
		"bash read none unchanged": 1,
		"bash terminal rtk:terminal filtered": 1,
		"read read none unchanged": 2,
		"read read read-dedup filtered": 2,
		"read read read-forced unchanged": 1,
	});
});
