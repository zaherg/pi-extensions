import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createAgentSession,
	createMcpExtension,
	DefaultResourceLoader,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionError,
	getPackageDir,
	type McpServerConfig,
	RpcClient,
	SessionManager,
	SettingsManager,
	wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { isPhpStormRunning } from "../phpstorm-mcp/running.ts";
import { filterPosthook } from "../rtk-pi-extended/bridge.ts";
import { structureCheck } from "../rtk-pi-extended/policy.ts";
import { resolveExecutable } from "../shared/executable.ts";

interface PackageManifest {
	pi: {
		extensions: string[];
	};
}

const MANIFEST = JSON.parse(
	readFileSync(resolve("package.json"), "utf8"),
) as PackageManifest;
const ALL_EXTENSION_PATHS = MANIFEST.pi.extensions.map((p: string) =>
	resolve(p),
);
const EXPECTED_COMMANDS = [
	"exit",
	"git",
	"progress",
	"rtk-coverage",
	"rtk-gain",
	"trace",
	"wip",
	"workers",
];

function cleanGitEnv(
	overrides: Record<string, string> = {},
): Record<string, string> {
	const base: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) base[key] = value;
	}
	return {
		...base,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		...overrides,
	};
}

function createTempGitRepo(
	root: string,
	env: Record<string, string>,
): string {
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-b", "main", repo], { env, stdio: "pipe" });
	writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: repo, env, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "initial"], {
		cwd: repo,
		env,
		stdio: "pipe",
	});
	return repo;
}

function hostExec(
	command: string,
	args: string[],
	options?: { timeout?: number; maxBuffer?: number },
): Promise<ExecResult> {
	return new Promise((resolveResult, rejectResult) => {
		execFile(
			command,
			args,
			{ timeout: options?.timeout, maxBuffer: options?.maxBuffer },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") {
					rejectResult(error);
					return;
				}
				resolveResult({
					stdout: String(stdout),
					stderr: String(stderr),
					code: error && typeof error.code === "number" ? error.code : 0,
					killed: Boolean(error?.killed),
					truncated: false,
				});
			},
		);
	});
}

describe("Pi 1.6 real harness integration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads all 9 extensions together in real createAgentSession with zero errors or collisions and runs full lifecycle", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-sdk-all9-"));
		tempDirs.push(tmp);
		const prevHome = process.env.HOME;
		process.env.HOME = tmp;
		const env = cleanGitEnv({ HOME: tmp });
		const repo = createTempGitRepo(tmp, env);
		const agentDir = join(tmp, "agent");

		const loader = new DefaultResourceLoader({
			cwd: repo,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: ALL_EXTENSION_PATHS,
		});
		await loader.reload();

		const sessionManager = SessionManager.inMemory(repo);
		const { session, extensionsResult } = await createAgentSession({
			cwd: repo,
			agentDir,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			noTools: "builtin",
		});

		const runtimeErrors: ExtensionError[] = [];
		try {
			assert.deepEqual(extensionsResult.errors, []);
			await session.bindExtensions({
				onError: (err: ExtensionError) => runtimeErrors.push(err),
			});
			const runner = session.extensionRunner;
			assert.ok(runner, "expected real ExtensionRunner");

			assert.deepEqual(runner.getCommandDiagnostics(), []);
			assert.deepEqual(runner.getShortcutDiagnostics(), []);
			assert.deepEqual(
				runner
					.getRegisteredCommands()
					.map((c) => c.name)
					.sort(),
				EXPECTED_COMMANDS,
			);
			assert.deepEqual(runner.getActiveTools().sort(), ["progress"]);
			assert.ok(
				runner.getEntryRenderer("git-output"),
				"expected git-output entry renderer",
			);

			// 1. before_agent_start stays clean when progress tracking is not enabled.
			const beforeEmpty = await runner.emitBeforeAgentStart(
				{ messageType: "user", prompt: "hello" },
				{
					cwd: repo,
					selectedTools: ["progress"],
					toolSnippets: {},
					promptGuidelines: [],
					contextFiles: [],
					skills: [],
				},
			);
			assert.equal(beforeEmpty.messages.length, 0);

			// 2. Enable progress via real /progress start command, mutate via real wrapped progress tool,
			//    and verify real before_agent_start injects the saved task into the model prompt.
			const progressCmd = runner.getCommand("progress");
			assert.ok(progressCmd);
			await progressCmd.handler("start", runner.createCommandContext());
			const registeredProgress = runner
				.getAllRegisteredTools()
				.find((t) => t.definition.name === "progress");
			assert.ok(registeredProgress, "expected registered progress tool");
			const wrappedProgress = wrapRegisteredTool(registeredProgress, runner);
			const addTaskRes = await wrappedProgress.execute("prog-1", {
				action: "add_task",
				expected_revision: 0,
				title: "Verify Pi harness",
				description: "Confirm real SDK tool + prompt injection",
				steps: ["Execute wrapped tool"],
			});
			assert.ok(
				JSON.stringify(addTaskRes.details).includes("Verify Pi harness"),
				"expected wrapped progress tool to persist task",
			);
			const isolatedProgressFile = join(
				tmp,
				".config",
				"ai-sessions",
				"repo",
				"progress.json",
			);
			assert.equal(
				existsSync(isolatedProgressFile),
				true,
				"expected progress file written inside isolated HOME",
			);
			const beforeWithProgress = await runner.emitBeforeAgentStart(
				{ messageType: "user", prompt: "continue" },
				{
					cwd: repo,
					selectedTools: ["progress"],
					toolSnippets: {},
					promptGuidelines: [],
					contextFiles: [],
					skills: [],
				},
			);
			assert.equal(beforeWithProgress.messages.length, 1);
			const injected = beforeWithProgress.messages[0];
			assert.equal(injected?.customType, "progress-context");
			assert.equal(injected?.display, false);
			assert.equal(typeof injected?.content, "string");
			assert.ok(
				typeof injected?.content === "string" &&
					injected.content.includes(
						"1 tasks; 0/1 steps completed; 0 blocked; revision 1.",
					),
				`expected exact progress summary in before_agent_start, got ${JSON.stringify(injected?.content)}`,
			);

			// 3. tool_result chaining through real ExtensionRunner (read dedup + bash passthrough + subagent)
			const fileLines = Array.from(
				{ length: 40 },
				(_, i) =>
					`export const line${String(i + 1).padStart(2, "0")} = "payload-for-real-dedup-${i}";`,
			).join("\n");
			const firstRead = await runner.emitToolResult({
				type: "tool_result",
				toolCallId: "read-1",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: fileLines }],
				details: undefined,
				isError: false,
			});
			assert.equal(
				firstRead,
				undefined,
				"first unique read should pass through unchanged",
			);

			// Record the first read in the real SessionManager so rtk-pi-extended sees it in branch context.
			const readEntryId = sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: fileLines }],
				isError: false,
				timestamp: Date.now(),
			});

			const secondRead = await runner.emitToolResult({
				type: "tool_result",
				toolCallId: "read-2",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: fileLines }],
				details: undefined,
				isError: false,
			});
			assert.ok(
				secondRead?.content,
				"duplicate read in same branch should be deduplicated by rtk-pi-extended",
			);
			const secondText = secondRead.content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			assert.ok(
				secondText.length < fileLines.length,
				`expected deduplicated read (${secondText.length}) < original (${fileLines.length})`,
			);

			// Small bash result passes through untouched.
			const smallBash = await runner.emitToolResult({
				type: "tool_result",
				toolCallId: "bash-1",
				toolName: "bash",
				input: { command: "echo ok" },
				content: [{ type: "text", text: "ok\n" }],
				details: undefined,
				isError: false,
			});
			assert.equal(smallBash, undefined);

			// Subagent workflowChildren shape handled cleanly by worker-board without UI crashes.
			const workflowDetails = {
				mode: "workflow",
				results: [],
				workflowChildren: {
					version: 1,
					workflowState: "completed",
					children: [
						{
							agent: "reviewer",
							task: "check diff",
							stopReason: "stop",
							state: "completed",
						},
					],
				},
			};
			await runner.emit({
				type: "tool_execution_start",
				toolCallId: "sub-1",
				toolName: "subagent",
				args: { task: "check diff" },
			});
			await runner.emit({
				type: "tool_execution_update",
				toolCallId: "sub-1",
				toolName: "subagent",
				args: { task: "check diff" },
				partialResult: {
					content: [{ type: "text", text: "running..." }],
					details: workflowDetails,
				},
			});
			await runner.emit({
				type: "tool_execution_end",
				toolCallId: "sub-1",
				toolName: "subagent",
				result: {
					content: [{ type: "text", text: "done" }],
					details: workflowDetails,
				},
				isError: false,
			});

			// 4. Verify CustomEntry isolation in real Pi buildSessionContext()
			sessionManager.appendCustomEntry("git-output", "## main\n");
			const customEntries = sessionManager
				.getEntries()
				.filter((e) => e.type === "custom");
			assert.ok(
				customEntries.some((e) => e.customType === "git-output"),
				"expected custom entry in raw session entries",
			);
			const projected = sessionManager.buildSessionContext();
			assert.ok(
				!JSON.stringify(projected.messages).includes("git-output"),
				"CustomEntry must never leak into LLM buildSessionContext()",
			);

			// 5. Full turn/session lifecycle via real emitBoundary + SDK closure reuse (shutdown -> start -> quit -> dispose)
			const assistantMsg = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "done" }],
				api: "openai-responses" as const,
				provider: "openai" as const,
				model: "gpt-5",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			const assistantEntryId = sessionManager.appendMessage(assistantMsg);
			await runner.emitBoundary(
				{
					type: "turn_end",
					turnIndex: 0,
					message: assistantMsg,
					toolResults: [],
					messageEntryId: assistantEntryId,
					toolResultEntryIds: [readEntryId],
					outcome: "completed",
				},
				() => ({
					contextEntries: sessionManager.buildSessionProjection().entries,
					contextMessages: sessionManager.buildSessionContext().messages,
					llmMessages: [],
					pendingMessages: [],
					canContinue: true,
				}),
			);
			await runner.emit({ type: "agent_end", messages: [] });
			await runner.emit({
				type: "agent_settled",
				aborted: false,
			});
			await runner.emit({
				type: "session_tree",
				newLeafId: sessionManager.getLeafId(),
				oldLeafId: null,
				fromExtension: false,
			});
			await runner.emit({
				type: "session_compact",
				compactionEntry: {
					type: "compaction",
					id: "cmp-1",
					parentId: sessionManager.getLeafId(),
					timestamp: new Date().toISOString(),
					summary: "summary",
					firstKeptEntryId: "cmp-1",
					tokensBefore: 100,
				},
				fromExtension: false,
				reason: "manual",
				willRetry: false,
			});
			await runner.emit({ type: "session_shutdown", reason: "new" });
			await runner.emit({ type: "session_start", reason: "new" });
			await runner.emit({ type: "session_shutdown", reason: "quit" });

			assert.deepEqual(
				runtimeErrors,
				[],
				`unexpected extension runtime errors: ${JSON.stringify(runtimeErrors)}`,
			);
		} finally {
			await session.dispose();
			// Allow any background microtasks scheduled before dispose to settle cleanly without unhandled rejections.
			await new Promise((r) => setTimeout(r, 30));
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});

	it("accepts phpstorm-mcp server config through Pi's real createMcpExtension without unhandled server errors", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-sdk-mcp-"));
		tempDirs.push(tmp);
		const agentDir = join(tmp, "agent");

		const registeredEvents: Array<{ name: string; config: McpServerConfig }> =
			[];
		const transportConfigs: Array<{ name: string; config: McpServerConfig }> =
			[];
		const phpstormConfig: McpServerConfig = {
			type: "stdio",
			env: { IJ_MCP_SERVER_PORT: "64442" },
			command: join(tmp, "fake-phpstorm"),
			args: ["stdioMcpServer"],
		};

		const registerFixtureExtension = (pi: ExtensionAPI): void => {
			pi.on("mcp_servers_change", (event) => {
				for (const server of event.servers) {
					registeredEvents.push({
						name: server.name,
						config: server.config,
					});
				}
			});
			pi.on("session_start", () => {
				pi.registerMcpServer("phpstorm", phpstormConfig);
			});
		};

		const mcpExt = createMcpExtension({
			loadConfig: () => ({ servers: [], errors: [] }),
			createTransport: (entry) => {
				transportConfigs.push({ name: entry.name, config: entry.config });
				throw new Error("transport intentionally stubbed for contract test");
			},
			startupWaitMs: 50,
		});

		const loader = new DefaultResourceLoader({
			cwd: tmp,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [mcpExt, registerFixtureExtension],
		});
		await loader.reload();

		const { session, extensionsResult } = await createAgentSession({
			cwd: tmp,
			agentDir,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(tmp),
			settingsManager: SettingsManager.inMemory(),
			noTools: "all",
		});

		const runtimeErrors: ExtensionError[] = [];
		try {
			assert.deepEqual(extensionsResult.errors, []);
			await session.bindExtensions({
				onError: (err: ExtensionError) => runtimeErrors.push(err),
			});
			const runner = session.extensionRunner;
			assert.ok(runner);
			assert.equal(runner.hasHandlers("mcp_servers_change"), true);

			// Allow the async mcp_servers_change dispatch triggered by registerMcpServer to flush.
			await new Promise((r) => setTimeout(r, 50));

			assert.ok(
				registeredEvents.some(
					(ev) =>
						ev.name === "phpstorm" &&
						ev.config.type === "stdio" &&
						"command" in ev.config &&
						ev.config.args?.[0] === "stdioMcpServer",
				),
				`expected phpstorm MCP server event, got ${JSON.stringify(registeredEvents)}`,
			);
			assert.ok(
				transportConfigs.some(
					(tc) =>
						tc.name === "phpstorm" &&
						tc.config.type === "stdio" &&
						"env" in tc.config &&
						tc.config.env?.IJ_MCP_SERVER_PORT === "64442",
				),
				`expected real createMcpExtension to invoke createTransport for phpstorm, got ${JSON.stringify(transportConfigs)}`,
			);
			assert.deepEqual(runtimeErrors, []);
		} finally {
			await session.dispose();
		}
	});

	it("boots all 9 extensions in a hermetically isolated Pi RPC subprocess and executes /wip, /progress, /rtk-gain, /rtk-coverage, /trace, and /workers", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-rpc-all9-"));
		tempDirs.push(tmp);
		const env = cleanGitEnv({
			HOME: tmp,
			PI_CODING_AGENT_DIR: join(tmp, "agent"),
			PI_OFFLINE: "1",
		});
		const repo = createTempGitRepo(tmp, env);
		writeFileSync(join(repo, "dirty.txt"), "changed\n", "utf8");

		const client = new RpcClient({
			cliPath: join(getPackageDir(), "dist", "cli.js"),
			cwd: repo,
			env,
			args: [
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-mcp",
				"--no-session",
				"--offline",
				...ALL_EXTENSION_PATHS.flatMap((p: string) => ["-e", p]),
			],
		});

		try {
			await client.start();
			const state = await client.getState();
			assert.equal(state.isStreaming, false);

			const commands = await client.getCommands();
			assert.deepEqual(
				commands.map((c) => c.name).sort(),
				EXPECTED_COMMANDS,
			);

			// Execute /wip end-to-end through Pi's real RPC command loop and verify real git commit!
			assert.equal(await client.prompt("/wip"), "handled");
			const deadline = Date.now() + 5_000;
			let headSubject = "";
			while (Date.now() < deadline) {
				headSubject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
					cwd: repo,
					env,
					encoding: "utf8",
				}).trim();
				if (headSubject === "wip") break;
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.equal(headSubject, "wip");
			const porcelain = execFileSync("git", ["status", "--porcelain"], {
				cwd: repo,
				env,
				encoding: "utf8",
			}).trim();
			assert.equal(porcelain, "");

			// Exercise all non-TUI slash commands cleanly over RPC with zero stderr errors.
			assert.equal(await client.prompt("/progress"), "handled");
			assert.equal(await client.prompt("/rtk-gain"), "handled");
			assert.equal(await client.prompt("/rtk-coverage 1 all"), "handled");
			assert.equal(await client.prompt("/trace"), "handled");
			assert.equal(await client.prompt("/workers"), "handled");

			assert.equal(client.getStderr(), "");
		} finally {
			await client.stop();
		}
	});

	it(
		"filters and recalls byte-for-byte against the real installed rtk binary across all 3 bundled profiles and parses live rtk gain JSON",
		{ skip: !resolveExecutable("rtk") ? "rtk binary not on PATH" : false },
		async () => {
			const repeatedTerminal = `${Array.from(
				{ length: 120 },
				() =>
					"\x1b[32mPASS\x1b[0m src/foo.test.ts: repeated status output line with padding 0123456789",
			).join("\n")}\nDone.\n`;
			const termRes = await filterPosthook(
				"bash",
				repeatedTerminal,
				{ configDirectory: resolve("rtk-pi-extended/rtk/terminal") },
				structureCheck("terminal"),
				true,
			);
			assert.equal(termRes.kind, "filtered");
			assert.ok(termRes.text.length < repeatedTerminal.length);

			const singleFileListing = `src/big-file.ts\n${Array.from(
				{ length: 360 },
				(_, i) => ` ${i + 1}: const match${i} = computeValue(${i});`,
			).join("\n")}\n`;
			const listRes = await filterPosthook(
				"grep",
				singleFileListing,
				{ configDirectory: resolve("rtk-pi-extended/rtk/listing") },
				structureCheck("listing"),
				true,
			);
			assert.equal(listRes.kind, "filtered");
			assert.ok(listRes.text.length < singleFileListing.length);

			const repeatedGeneric = `${Array.from(
				{ length: 120 },
				() =>
					'{"status":"ok","payload":"repeated generic line for dedup test 0123456789"}',
			).join("\n")}\nDone.\n`;
			const genRes = await filterPosthook(
				"custom_tool",
				repeatedGeneric,
				{ configDirectory: resolve("rtk-pi-extended/rtk/generic") },
				structureCheck("generic"),
				true,
			);
			assert.equal(genRes.kind, "filtered");
			assert.ok(genRes.text.length < repeatedGeneric.length);

			// Verify real `rtk gain --format json` matches rtk-gain's expected counter schema.
			const rtkBin = resolveExecutable("rtk");
			assert.ok(rtkBin);
			const gainRaw = execFileSync(rtkBin, ["gain", "--format", "json"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			const gainParsed = JSON.parse(gainRaw) as {
				summary?: Record<string, unknown>;
			};
			assert.ok(gainParsed.summary && typeof gainParsed.summary === "object");
			for (const key of [
				"total_commands",
				"total_input",
				"total_output",
				"total_saved",
			]) {
				const value: unknown = gainParsed.summary[key];
				assert.equal(
					typeof value,
					"number",
					`expected numeric ${key} in live rtk gain JSON`,
				);
				assert.equal(Number.isSafeInteger(value), true);
				assert.ok((value as number) >= 0);
			}
		},
	);

	it(
		"suspends and restores real Pi interactive TUI for /git and exits cleanly via /exit in a real PTY",
		{
			skip:
				process.platform === "win32" ||
				!resolveExecutable("pi") ||
				!resolveExecutable("python3")
					? "requires POSIX with pi and python3 on PATH"
					: false,
		},
		() => {
			const tmp = mkdtempSync(join(tmpdir(), "pi-pty-e2e-"));
			tempDirs.push(tmp);
			const env = cleanGitEnv({ HOME: tmp });
			const repo = createTempGitRepo(tmp, env);
			writeFileSync(join(repo, "untracked.txt"), "dirty\n", "utf8");
			const agentDir = join(tmp, "agent");

			const pyScript = `
import fcntl, os, pty, re, select, subprocess, sys, termios, time

repo, home_dir, agent_dir, git_ext, exit_ext = sys.argv[1:6]
master, slave = pty.openpty()
env = {
    **os.environ,
    "HOME": home_dir,
    "TERM": "xterm-256color",
    "PI_CODING_AGENT_DIR": agent_dir,
    "PI_OFFLINE": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
}
cmd = [
    "pi",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-mcp",
    "--no-session",
    "--offline",
    "--tui-mode", "regular",
    "-e", git_ext,
    "-e", exit_ext,
]

def attach_ctty():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

proc = subprocess.Popen(
    cmd,
    cwd=repo,
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
    preexec_fn=attach_ctty,
)
os.close(slave)
buf = bytearray()

def drain(duration):
    end = time.time() + duration
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.05)
        if master in r:
            try:
                chunk = os.read(master, 4096)
                if not chunk:
                    break
                buf.extend(chunk)
            except OSError:
                break

try:
    drain(2.0)
    os.write(master, b"/git status -sb\\r")
    drain(2.0)
    os.write(master, b"/exit\\r")
    drain(1.5)
    rc = proc.wait(timeout=4.0)
    plain = re.sub(r"\\x1b(?:\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\[[0-9;?]*[ -/]*[@-~]|[@-Z\\\\-_])", "", buf.decode("utf-8", errors="replace"))
    assert rc == 0, f"expected exit 0, got {rc}"
    assert "/git" in plain, f"missing /git inline entry header"
    assert "## main" in plain and "?? untracked.txt" in plain, f"missing git status in TUI output"
    assert "Could not save" not in plain and "failed" not in plain.lower(), f"unexpected error in output"
finally:
    os.close(master)
`;
			const pyBin = resolveExecutable("python3");
			assert.ok(pyBin);
			execFileSync(
				pyBin,
				[
					"-c",
					pyScript,
					repo,
					tmp,
					agentDir,
					resolve("git/index.ts"),
					resolve("exit.ts"),
				],
				{ env, stdio: "pipe", timeout: 15_000 },
			);
		},
	);

	it("runs progress background updater end-to-end through real ModelRegistry.streamSimple over loopback HTTP SSE", async () => {
		const proposal = JSON.stringify({
			tasks: [
				{
					id: null,
					title: "Live streamSimple task",
					description:
						"Created by real progress background updater over HTTP SSE",
					steps: [
						{
							id: null,
							description: "Verify end-to-end streamSimple",
							status: "completed",
							blocked_by: null,
						},
					],
				},
			],
		});

		const receivedBodies: string[] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			req.on("end", () => {
				receivedBodies.push(body);
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
				});
				const now = Math.floor(Date.now() / 1000);
				const chunk1 = {
					id: "chatcmpl-progress-1",
					object: "chat.completion.chunk",
					created: now,
					model: "progress-test",
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: proposal },
							finish_reason: null,
						},
					],
				};
				const chunk2 = {
					id: "chatcmpl-progress-1",
					object: "chat.completion.chunk",
					created: now,
					model: "progress-test",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 42,
						completion_tokens: 18,
						total_tokens: 60,
					},
				};
				res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
				res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
				res.write("data: [DONE]\n\n");
				res.end();
			});
		});

		await new Promise<void>((resolveListen) =>
			server.listen(0, "127.0.0.1", () => resolveListen()),
		);
		const { port } = server.address() as AddressInfo;
		const tmp = mkdtempSync(join(tmpdir(), "pi-bg-sse-"));
		tempDirs.push(tmp);
		const prevHome = process.env.HOME;
		process.env.HOME = tmp;

		try {
			const agentDir = join(tmp, "agent");
			const settingsManager = SettingsManager.inMemory({
				defaultProvider: "local-sse",
				defaultModel: "progress-test",
			});
			const loader = new DefaultResourceLoader({
				cwd: tmp,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [resolve("progress/index.ts")],
			});
			await loader.reload();

			const sessionManager = SessionManager.inMemory(tmp);
			const { session, extensionsResult } = await createAgentSession({
				cwd: tmp,
				agentDir,
				resourceLoader: loader,
				sessionManager,
				settingsManager,
				noTools: "builtin",
			});
			const runtimeErrors: ExtensionError[] = [];
			try {
				assert.deepEqual(extensionsResult.errors, []);
				await session.bindExtensions({
					onError: (err: ExtensionError) => runtimeErrors.push(err),
				});
				const runner = session.extensionRunner;
				assert.ok(runner);
				runner.createContext().modelRegistry.registerProvider("local-sse", {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					apiKey: "test-key",
					api: "openai-completions",
					models: [
						{
							id: "progress-test",
							name: "Progress Test",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				});

				const progressCmd = runner.getCommand("progress");
				assert.ok(progressCmd);
				await progressCmd.handler("start", runner.createCommandContext());
				sessionManager.appendMessage({
					role: "user",
					content: "Please verify streamSimple end-to-end.",
					timestamp: Date.now(),
				});
				sessionManager.appendMessage({
					role: "assistant",
					content: [
						{ type: "text", text: "Verified streamSimple end-to-end." },
					],
					api: "openai-completions",
					provider: "local-sse",
					model: "progress-test",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});

				await runner.emit({ type: "agent_settled", aborted: false });
				// Quit shutdown drains the in-flight background HTTP SSE update cleanly.
				await runner.emit({ type: "session_shutdown", reason: "quit" });

				assert.equal(receivedBodies.length, 1);
				assert.ok(
					receivedBodies[0]?.includes("Verify streamSimple") ||
						receivedBodies[0]?.includes(
							"Please verify streamSimple end-to-end.",
						),
				);

				const savedPath = join(
					tmp,
					".config",
					"ai-sessions",
					basename(tmp),
					"progress.json",
				);
				const saved = JSON.parse(readFileSync(savedPath, "utf8")) as {
					revision: number;
					tasks: Array<{
						title: string;
						steps: Array<{ status: string | null }>;
					}>;
				};
				assert.equal(saved.revision, 1);
				assert.equal(saved.tasks.length, 1);
				assert.equal(saved.tasks[0]?.title, "Live streamSimple task");
				assert.equal(saved.tasks[0]?.steps[0]?.status, "completed");

				const usageEntries = sessionManager
					.getEntries()
					.filter(
						(e) => e.type === "custom" && e.customType === "progress-usage",
					);
				assert.equal(usageEntries.length, 1);
				const usageEntry = usageEntries[0];
				assert.ok(usageEntry && usageEntry.type === "custom");
				const usageData = usageEntry.data as {
					provider: string;
					model: string;
					usage: { input: number; output: number; totalTokens: number };
				};
				assert.equal(usageData.provider, "local-sse");
				assert.equal(usageData.model, "progress-test");
				assert.equal(usageData.usage.input, 42);
				assert.equal(usageData.usage.output, 18);
				assert.equal(usageData.usage.totalTokens, 60);

				const projected = sessionManager.buildSessionContext();
				assert.ok(
					!JSON.stringify(projected.messages).includes("progress-usage"),
					"progress-usage CustomEntry must never leak into LLM context",
				);

				// Verify the persisted background update is reflected in before_agent_start.
				const beforeNext = await runner.emitBeforeAgentStart(
					{ messageType: "user", prompt: "status?" },
					{
						cwd: tmp,
						selectedTools: ["progress"],
						toolSnippets: {},
						promptGuidelines: [],
						contextFiles: [],
						skills: [],
					},
				);
				assert.equal(beforeNext.messages.length, 1);
				assert.ok(
					typeof beforeNext.messages[0]?.content === "string" &&
						beforeNext.messages[0].content.includes(
							"1 tasks; 1/1 steps completed; 0 blocked; revision 1.",
						),
				);
				assert.deepEqual(runtimeErrors, []);
			} finally {
				await session.dispose();
			}
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			await new Promise<void>((resolveClose) =>
				server.close(() => resolveClose()),
			);
		}
	});

	it("connects phpstorm-mcp live to the running PhpStorm IDE through real createMcpExtension and invokes a real MCP tool", async (t) => {
		const realHome = homedir();
		const phpstormBin = join(
			realHome,
			"Applications",
			"PhpStorm.app",
			"Contents",
			"MacOS",
			"phpstorm",
		);
		let running = false;
		if (process.platform === "darwin" && existsSync(phpstormBin)) {
			try {
				running = await isPhpStormRunning({ exec: hostExec });
			} catch {
				running = false;
			}
		}
		if (!running) {
			t.skip("PhpStorm IDE is not currently running on this host");
			return;
		}

		const tmp = mkdtempSync(join(tmpdir(), "pi-phpstorm-live-"));
		tempDirs.push(tmp);
		symlinkSync(join(realHome, "Applications"), join(tmp, "Applications"));
		const prevHome = process.env.HOME;
		process.env.HOME = tmp;

		try {
			const agentDir = join(tmp, ".pi", "agent");
			mkdirSync(agentDir, { recursive: true });
			const cfgPath = join(agentDir, "pi-phpstorm-mcp.json");

			// 1. Negative contract check: even while PhpStorm is running, TUI mode must NOT register MCP or write config.
			{
				const mcpExt = createMcpExtension({
					loadConfig: () => ({ servers: [], errors: [] }),
					startupWaitMs: 500,
				});
				const loader = new DefaultResourceLoader({
					cwd: resolve("."),
					agentDir,
					settingsManager: SettingsManager.inMemory(),
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [mcpExt],
					additionalExtensionPaths: [resolve("phpstorm-mcp/index.ts")],
				});
				await loader.reload();
				const { session } = await createAgentSession({
					cwd: resolve("."),
					agentDir,
					resourceLoader: loader,
					sessionManager: SessionManager.inMemory(resolve(".")),
					settingsManager: SettingsManager.inMemory(),
					noTools: "builtin",
				});
				let runner: typeof session.extensionRunner | undefined;
				try {
					await session.bindExtensions({ mode: "tui" });
					runner = session.extensionRunner;
					await new Promise((r) => setTimeout(r, 200));
					assert.equal(existsSync(cfgPath), false);
					assert.equal(
						runner
							?.getAllRegisteredTools()
							.filter((tool) =>
								tool.definition.name.startsWith("mcp__phpstorm__"),
							).length ?? 0,
						0,
					);
				} finally {
					if (runner) await runner.emit({ type: "session_shutdown", reason: "quit" });
					await session.dispose();
				}
			}

			// 2. Positive live E2E check: RPC mode detects PhpStorm, writes 0o600 config, connects via stdioMcpServer,
			//    discovers real PhpStorm MCP tools, executes a read-only tool call, and shuts down cleanly.
			const mcpExt = createMcpExtension({
				loadConfig: () => ({ servers: [], errors: [] }),
				startupWaitMs: 5_000,
			});
			const loader = new DefaultResourceLoader({
				cwd: resolve("."),
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [mcpExt],
				additionalExtensionPaths: [resolve("phpstorm-mcp/index.ts")],
			});
			await loader.reload();
			const { session, extensionsResult } = await createAgentSession({
				cwd: resolve("."),
				agentDir,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(resolve(".")),
				settingsManager: SettingsManager.inMemory(),
				noTools: "builtin",
			});

			const runtimeErrors: ExtensionError[] = [];
			let runner: typeof session.extensionRunner | undefined;
			try {
				assert.deepEqual(extensionsResult.errors, []);
				await session.bindExtensions({
					mode: "rpc",
					onError: (err: ExtensionError) => runtimeErrors.push(err),
				});
				runner = session.extensionRunner;
				assert.ok(runner);

				let phpstormTools = runner
					.getAllRegisteredTools()
					.filter((tool) => tool.definition.name.startsWith("mcp__phpstorm__"));
				const deadline = Date.now() + 8_000;
				while (phpstormTools.length === 0 && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 150));
					phpstormTools = runner
						.getAllRegisteredTools()
						.filter((tool) =>
							tool.definition.name.startsWith("mcp__phpstorm__"),
						);
				}

				assert.equal(existsSync(cfgPath), true);
				assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
				assert.ok(
					phpstormTools.length > 0,
					"expected live PhpStorm IDE to expose mcp__phpstorm__* tools",
				);

				const readOnlyTool =
					phpstormTools.find(
						(tool) =>
							tool.definition.name === "mcp__phpstorm__get_all_open_file_paths",
					) ?? phpstormTools[0];
				assert.ok(readOnlyTool);
				const wrapped = wrapRegisteredTool(readOnlyTool, runner);
				const toolResult = await wrapped.execute("live-phpstorm-1", {});
				assert.ok(
					Array.isArray(toolResult.content) && toolResult.content.length > 0,
					"expected non-empty MCP response from live PhpStorm IDE",
				);
				assert.deepEqual(runtimeErrors, []);
			} finally {
				if (runner)
					await runner.emit({ type: "session_shutdown", reason: "quit" });
				await session.dispose();
			}
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});
});
