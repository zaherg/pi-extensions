import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import progressExtension from "../index.ts";
import { type ProgressResult, runProgress } from "../store.ts";

const CLI_PATH = resolve("progress/cli.ts");

function runCli(
	args: readonly string[],
	stdin: string,
	options: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], {
			env: options.env,
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const outChunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({
				code,
				stdout: Buffer.concat(outChunks).toString("utf8"),
				stderr: Buffer.concat(errChunks).toString("utf8"),
			});
		});
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}

describe("progress/cli and progress tool", () => {
	let rootTmp = "";
	let homeDir = "";
	let projectDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		rootTmp = await realpath(await mkdtemp(join(tmpdir(), "pi-progress-cli-")));
		homeDir = join(rootTmp, "home");
		projectDir = join(rootTmp, "work", "cli-project");
		await mkdir(homeDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		process.env.HOME = homeDir;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await rm(rootTmp, { recursive: true, force: true });
	});

	test("CLI subprocess supports --help, JSON stdin CRUD roundtrip, and structured error exits", async () => {
		const env = { ...process.env, HOME: homeDir };

		const help = await runCli(["--help"], "", { env });
		assert.equal(help.code, 0);
		assert.match(help.stdout, /Usage: node cli\.ts/);
		assert.equal(existsSync(join(homeDir, ".config")), false);

		const untrackedErr = await runCli(
			["--cwd", projectDir],
			JSON.stringify({
				action: "add_task",
				expected_revision: 0,
				title: "T",
				description: "D",
				steps: ["S"],
			}),
			{ env },
		);
		assert.equal(untrackedErr.code, 1);
		assert.equal(
			(JSON.parse(untrackedErr.stderr) as { code: string }).code,
			"NOT_STARTED",
		);

		const started = await runCli([], JSON.stringify({ action: "start" }), {
			env,
			cwd: projectDir,
		});
		assert.equal(started.code, 0);

		const added = await runCli(
			["--cwd", projectDir],
			JSON.stringify({
				action: "add_task",
				expected_revision: 0,
				title: "Migrate DB",
				description: "Expand/contract",
				steps: ["Add column"],
			}),
			{ env },
		);
		assert.equal(added.code, 0);
		const parsed = JSON.parse(added.stdout) as ProgressResult;
		assert.equal(parsed.document?.revision, 1);
	});

	test("progress tool blocks model-initiated start, redacts secrets, and truncates >50 KiB responses", async () => {
		let registeredTool: ToolDefinition | undefined;
		progressExtension({
			on: () => () => {},
			registerTool(tool: ToolDefinition) {
				registeredTool = tool;
			},
			registerCommand: () => {},
			getSettings: () => ({}),
			appendEntry: () => {},
		} as unknown as ExtensionAPI);
		assert.ok(registeredTool);

		const toolCtx = { cwd: projectDir } as unknown as ExtensionToolContext;
		await assert.rejects(
			registeredTool.execute(
				"c1",
				{ action: "start" } as unknown as Record<string, unknown>,
				undefined,
				undefined,
				toolCtx,
			),
			/Use \/progress start/,
		);

		await runProgress(projectDir, { action: "start" });
		const added = (await registeredTool.execute(
			"c2",
			{
				action: "add_task",
				expected_revision: 0,
				title: "Task api_key=sk-1234567890abcdef1234",
				description: "d".repeat(55_000),
				steps: ["Step token=secret123"],
			},
			undefined,
			undefined,
			toolCtx,
		)) as AgentToolResult<ProgressResult>;

		assert.equal(
			added.details.document?.tasks[0]?.title.includes("sk-"),
			false,
		);
		assert.equal(
			added.details.document?.tasks[0]?.steps[0]?.description.includes(
				"secret123",
			),
			false,
		);
		const block = added.content[0];
		assert.ok(
			block?.type === "text" &&
				block.text.includes("[Truncated. Read the complete JSON at "),
		);
	});
});
