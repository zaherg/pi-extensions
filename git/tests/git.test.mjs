import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
	createRequire,
	registerHooks,
	syncBuiltinESMExports,
} from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CAPTURE_BYTES,
	gitResultMessage,
	terminalCaptureArgs,
} from "../terminal.ts";

assert.ok(
	process.env.PI_PACKAGE_ROOT,
	"Set PI_PACKAGE_ROOT to the installed Pi package.",
);
const requireHost = createRequire(
	join(process.env.PI_PACKAGE_ROOT, "package.json"),
);
const hostTui = requireHost.resolve("@earendil-works/pi-tui");
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(
			specifier === "@earendil-works/pi-tui" ? hostTui : specifier,
			context,
		);
	},
});
const { default: registerGit, gitShellCommand } = await import("../index.ts");
hooks.deregister();
const { visibleWidth } = await import(pathToFileURL(hostTui));

const success = {
	status: 0,
	signal: null,
	error: undefined,
	stdout: Buffer.alloc(0),
};

function harness(t, run = () => success) {
	const calls = [];
	const notices = [];
	const entries = [];
	const renderers = new Map();
	const lifecycle = [];
	const commands = new Map();
	const signalListeners = process.rawListeners("SIGINT");
	const replacement = mock.method(childProcess, "spawnSync", (...args) => {
		calls.push(args);
		return run(...args);
	});
	syncBuiltinESMExports();
	t.after(() => {
		replacement.mock.restore();
		syncBuiltinESMExports();
		assert.deepEqual(process.rawListeners("SIGINT"), signalListeners);
	});
	const pi = {
		registerCommand: (name, command) => commands.set(name, command),
		registerEntryRenderer: (name, renderer) => renderers.set(name, renderer),
		appendEntry: (name, data) =>
			entries.push({ type: "custom", customType: name, data }),
	};
	registerGit(pi);
	const ctx = {
		cwd: "/synthetic/project with spaces;literal",
		mode: "tui",
		isIdle: () => true,
		ui: {
			notify: (...args) => notices.push(args),
			custom: async (factory) => {
				let result;
				const component = factory(
					{
						stop: () => lifecycle.push("stop"),
						start: () => lifecycle.push("start"),
						requestRender: (force) => lifecycle.push(["render", force]),
					},
					{},
					{},
					(value) => {
						result = value;
						lifecycle.push("done");
					},
				);
				assert.deepEqual(component.render(40), []);
				component.invalidate();
				return result;
			},
		},
	};
	return {
		calls,
		notices,
		entries,
		renderers,
		pi,
		lifecycle,
		commands,
		ctx,
		run: (args = "") => commands.get("git").handler(args, ctx),
	};
}

test("only standalone quoted commit messages are rewritten", () => {
	for (const message of [
		'"something"',
		"'fix: quoted message'",
		String.raw`"say \"hello\""`,
		'""',
		'"line one\nline two"',
	]) {
		assert.equal(
			gitShellCommand(`commit ${message}`),
			`git commit -m ${message}`,
		);
	}
	for (const input of [
		"status",
		"add -p",
		"rebase -i HEAD~3",
		"push --force-with-lease",
		"update-ref refs/test HEAD",
		"my-custom-alias",
		"-C '../project with spaces' status",
		'-c alias.example="status --short" example',
		"commit",
		"commit path.txt",
		'commit -- "path.txt"',
		'commit -m "something" --amend',
		'commit "path.txt" --amend --no-edit',
		'commit "one" "two"',
		'commit "one" && git status',
		"log --oneline | head -3",
		'commit "unterminated',
		"status > result.txt",
		String.raw`add trailing\ `,
		"hash-object --stdin <<'EOF'\ncontent\nEOF\n",
		`status; printf '%s' "$HOME"`,
	]) {
		assert.equal(gitShellCommand(input), `git ${input}`);
	}
	assert.equal(
		gitShellCommand(' \tcommit "trimmed" \n'),
		'git commit -m "trimmed"',
	);
	assert.equal(gitShellCommand("  \n"), "git");
});

test("registers /git, runs the selected shell in cwd and returns inline without a pause", async (t) => {
	const h = harness(t);
	assert.deepEqual([...h.commands.keys()], ["git"]);
	assert.equal(h.calls.length, 0);
	await h.run('commit "something"');
	assert.deepEqual(h.calls[0], [
		"/bin/bash",
		terminalCaptureArgs(
			process.env.SHELL || "/bin/sh",
			'git commit -m "something"',
		),
		{
			cwd: h.ctx.cwd,
			stdio: ["inherit", "pipe", "inherit"],
			maxBuffer: CAPTURE_BYTES + 1024,
		},
	]);
	assert.equal(h.calls.length, 1, "success must not launch an Enter prompt");
	assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true], "done"]);
	assert.deepEqual(h.notices, []);
	assert.deepEqual(h.entries, [
		{
			type: "custom",
			customType: "git-output",
			data: "Git shell completed.\n(No output)",
		},
	]);
});

test("Git failures return the actual diagnostic as a normal message and allow the next command", async (t) => {
	let count = 0;
	const h = harness(t, () =>
		++count === 1
			? {
					...success,
					status: 128,
					stdout: Buffer.from("fatal: not a git repository\r\n"),
				}
			: success,
	);
	await assert.doesNotReject(h.run("status"));
	assert.equal(
		h.calls.length,
		1,
		"failures must return without an Enter prompt",
	);
	assert.deepEqual(h.notices, []);
	assert.equal(
		h.entries[0].data,
		"Git command failed (exit 128).\nfatal: not a git repository",
	);
	await h.run("--version");
	assert.equal(h.entries.at(-1).data, "Git shell completed.\n(No output)");
	assert.equal(h.calls.length, 2);
});

test("terminal capture keeps command data out of the fixed wrapper and routes native script variants", () => {
	const shell = "/synthetic/shell with spaces";
	const command = 'git status; printf "$HOME"';
	for (const platform of ["darwin", "linux"]) {
		const args = terminalCaptureArgs(shell, command, platform);
		assert.equal(args[0], "-c");
		assert.deepEqual(args.slice(2), [
			"pi-git",
			shell,
			command,
			String(CAPTURE_BYTES),
		]);
		assert.equal(args[1].includes(command), false);
		assert.match(args[1], /set -o pipefail/);
		assert.match(
			args[1],
			/\/usr\/bin\/tee \/dev\/tty \| \/usr\/bin\/tail -c "\$3"/,
		);
		assert.ok(
			args[1].includes(
				platform === "darwin"
					? `/usr/bin/script -q /dev/null /bin/bash -c 'trap : INT; "$1" -c "$2"; exit $?' pi-git "$1" "$2"`
					: 'SHELL="$1" /usr/bin/script -q -e -c "$2" /dev/null',
			),
		);
	}
	assert.throws(
		() => terminalCaptureArgs(shell, command, "win32"),
		/requires macOS or Linux/,
	);
});

test("failure messages strip terminal controls and redact common credentials before UI replay", () => {
	const raw = [
		"\u001b[31mfatal: authentication failed\u001b[0m",
		"https://user:synthetic-password@example.invalid/repo?token=synthetic-query",
		"Authorization: Bearer synthetic-bearer",
		"password=synthetic-assignment",
		"-----BEGIN PRIVATE KEY-----\nsynthetic-key\n-----END PRIVATE KEY-----",
		"fatal: useful final diagnostic\u0007\u202e",
	].join("\r\n");
	const message = gitResultMessage(Buffer.from(raw), 128);
	assert.ok(message.includes("fatal: authentication failed"));
	assert.ok(message.endsWith("fatal: useful final diagnostic"));
	for (const secret of [
		"synthetic-password",
		"synthetic-query",
		"synthetic-bearer",
		"synthetic-assignment",
		"synthetic-key",
		"\u001b",
		"\u0007",
		"\u202e",
	]) {
		assert.equal(message.includes(secret), false, secret);
	}
	assert.ok(message.includes("[REDACTED]"));
});

test("failure output is bounded and empty or truncated output is reported explicitly", () => {
	assert.equal(
		gitResultMessage(null, 128),
		"Git command failed (exit 128).\nNo diagnostic text was captured; check the terminal output.",
	);
	const raw = Buffer.from(
		`${"context line\n".repeat(2000)}fatal: retained ending\n`,
	).subarray(-CAPTURE_BYTES);
	const message = gitResultMessage(raw, 128);
	assert.ok(message.includes("[Last output only]"));
	assert.ok(message.endsWith("fatal: retained ending"));
	assert.ok(message.length < 4100);
	assert.ok(message.split("\n").length <= 22);
	assert.ok(
		gitResultMessage(Buffer.alloc(CAPTURE_BYTES, "x"), 1).includes(
			"No diagnostic text",
		),
	);
});

test("signals are reported without claiming success", async (t) => {
	let count = 0;
	const h = harness(t, () =>
		++count === 1 ? { ...success, status: null, signal: "SIGINT" } : success,
	);
	await h.run("add -p");
	assert.deepEqual(h.notices, []);
	assert.equal(
		h.entries[0].data,
		"Git shell stopped by SIGINT. Check git status before retrying.\nNo diagnostic text was captured; check the terminal output.",
	);
});

test("spawn errors restore the interface, skip the pause and do not expose error text", async (t) => {
	const h = harness(t, () => ({
		...success,
		status: null,
		error: new Error("synthetic-private-value"),
	}));
	await h.run("status");
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true], "done"]);
	assert.deepEqual(h.notices, []);
	assert.equal(
		h.entries[0].data,
		"Git shell could not be started. Check SHELL and the project directory.",
	);
});

test("unexpected execution errors restore Pi and clear the running guard", async (t) => {
	let fail = true;
	const h = harness(t, () => {
		if (fail) throw new Error("synthetic-private-value");
		return success;
	});
	await h.run("status");
	assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true]]);
	assert.deepEqual(h.notices, []);
	assert.equal(
		h.entries[0].data,
		"Git terminal execution failed. Check git status before retrying.",
	);
	fail = false;
	await h.run("status");
	assert.equal(h.entries.at(-1).data, "Git shell completed.\n(No output)");
});

test("entry persistence failure reports the completed result without rerunning Git", async (t) => {
	const h = harness(t, () => ({
		...success,
		stdout: Buffer.from("saved-result"),
	}));
	h.pi.appendEntry = () => {
		throw new Error("synthetic-private-value");
	};
	await h.run("status");
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.notices, [
		[
			"Could not save Git's inline result.\nGit shell completed.\nsaved-result",
			"warning",
		],
	]);
});

test("refuses RPC and headless modes before executing anything", async (t) => {
	const h = harness(t);
	for (const mode of ["rpc", "print", "json"]) {
		h.ctx.mode = mode;
		await assert.rejects(h.run("status"), /requires Pi's interactive terminal/);
	}
	assert.deepEqual(h.calls, []);
});

test("refuses to run while the agent is busy", async (t) => {
	const h = harness(t);
	h.ctx.isIdle = () => false;
	await h.run("status");
	assert.deepEqual(h.calls, []);
	assert.equal(h.notices[0][1], "warning");
});

test("overlapping command handlers cannot borrow the terminal twice", async (t) => {
	const h = harness(t);
	const gate = Promise.withResolvers();
	const custom = h.ctx.ui.custom;
	h.ctx.ui.custom = async (...args) => {
		await gate.promise;
		return custom(...args);
	};
	const first = h.run("status");
	try {
		await h.run("diff");
		assert.equal(h.calls.length, 0);
		assert.equal(h.notices[0][1], "warning");
	} finally {
		gate.resolve();
		await first;
	}
	assert.equal(h.calls.length, 1);
});

test("success output is sanitized before persistence and keeps Git indentation", async (t) => {
	const h = harness(t, () => ({
		...success,
		stdout: Buffer.from(
			" M source.ts\r\n\u001b[31mtoken=synthetic-secret\u001b[0m\n",
		),
	}));
	await h.run("status --short");
	assert.deepEqual(h.entries, [
		{
			type: "custom",
			customType: "git-output",
			data: "Git shell completed.\n M source.ts\ntoken=[REDACTED]",
		},
	]);
	assert.deepEqual(h.notices, []);
});

test("success output is bounded and labels discarded content", () => {
	const message = gitResultMessage(
		Buffer.from(`${"context\n".repeat(30)}last line`),
		0,
	);
	assert.ok(message.startsWith("Git shell completed.\n[Last output only]\n"));
	assert.ok(message.endsWith("last line"));
	assert.equal(message.split("\n").length, 22);
	assert.equal(
		gitResultMessage(Buffer.from(" "), 0),
		"Git shell completed.\n(No output)",
	);
});

test("inline renderer uses plain text and fits narrow and wide terminals", async (t) => {
	const output =
		" M source.ts\n# literal heading, not Markdown\n你好 🚀 ".repeat(4);
	const h = harness(t, () => ({ ...success, stdout: Buffer.from(output) }));
	await h.run("status");
	const renderer = h.renderers.get("git-output");
	assert.equal(typeof renderer, "function");
	const theme = { fg: (_color, text) => text };
	for (const width of [20, 45, 100]) {
		const component = renderer(h.entries[0], { expanded: false }, theme);
		const lines = component.render(width);
		assert.ok(lines.some((line) => line.includes("/git")));
		assert.ok(lines.join("\n").includes("# literal"));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		component.invalidate();
		assert.deepEqual(component.render(width), lines);
	}
	const invalid = renderer({ data: {} }, { expanded: false }, theme);
	assert.match(invalid.render(100).join("\n"), /Invalid saved Git output/);
});

test("custom Git entries survive session projection without entering model context", async (t) => {
	const { SessionManager } = await import(
		pathToFileURL(
			join(process.env.PI_PACKAGE_ROOT, "dist/core/session-manager.js"),
		)
	);
	const h = harness(t, () => ({
		...success,
		stdout: Buffer.from("synthetic-inline-output"),
	}));
	await h.run("status");
	const session = SessionManager.inMemory("/synthetic");
	for (const entry of h.entries)
		session.appendCustomEntry(entry.customType, entry.data);
	assert.equal(
		session.getEntries().at(-1).data,
		"Git shell completed.\nsynthetic-inline-output",
	);
	assert.deepEqual(session.buildSessionContext().messages, []);
	assert.equal(session.buildContextEntries().at(-1).customType, "git-output");
});

test("native Pi loading and real shell execution in an isolated repository", {
	timeout: 30_000,
}, async (t) => {
	assert.ok(
		process.env.PI_PACKAGE_ROOT,
		"Set PI_PACKAGE_ROOT to the installed Pi package.",
	);
	const root = await mkdtemp(join(tmpdir(), "pi-git test;-"));
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	Object.assign(env, {
		HOME: root,
		XDG_CONFIG_HOME: join(root, "config"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	});
	const git = (...args) =>
		childProcess
			.execFileSync("git", args, {
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 5_000,
				stdio: ["ignore", "pipe", "pipe"],
			})
			.trim();
	const shell = (input) =>
		childProcess.spawnSync("/bin/sh", ["-c", gitShellCommand(input)], {
			cwd: root,
			env,
			encoding: "utf8",
			timeout: 5_000,
		});
	try {
		const { loadExtensions } = await import(
			pathToFileURL(
				join(process.env.PI_PACKAGE_ROOT, "dist/core/extensions/loader.js"),
			)
		);
		const loaded = await loadExtensions(
			[fileURLToPath(new URL("../index.ts", import.meta.url))],
			root,
		);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		assert.deepEqual([...loaded.extensions[0].commands.keys()], ["git"]);
		assert.equal(loaded.extensions[0].tools.size, 0);
		assert.equal(loaded.extensions[0].handlers.size, 0);
		git("init", "--quiet", "--template=");
		git("config", "user.name", "Git Extension Test");
		git("config", "user.email", "git-extension@example.invalid");
		git("config", "commit.gpgsign", "false");
		await mkdir(join(root, "hooks"));
		git("config", "core.hooksPath", join(root, "hooks"));

		await t.test(
			"the shorthand commits only staged content with the exact message",
			async () => {
				await writeFile(join(root, "staged file.txt"), "staged version\n");
				assert.equal(shell('add "staged file.txt"').status, 0);
				await writeFile(join(root, "staged file.txt"), "unstaged version\n");
				await writeFile(join(root, "untracked.txt"), "leave alone\n");
				const message = 'keep $HOME; $(touch DO_NOT_CREATE) and "quotes"';
				assert.equal(shell(`commit '${message}'`).status, 0);
				assert.equal(git("log", "-1", "--format=%B"), message);
				assert.equal(git("show", "HEAD:staged file.txt"), "staged version");
				assert.equal(
					await readFile(join(root, "staged file.txt"), "utf8"),
					"unstaged version\n",
				);
				assert.match(git("status", "--porcelain"), /\?\? untracked.txt/);
				await assert.rejects(readFile(join(root, "DO_NOT_CREATE")), {
					code: "ENOENT",
				});
			},
		);

		await t.test(
			"native options, plumbing, aliases and explicit shell syntax pass through",
			() => {
				assert.equal(shell('commit -m "explicit" --allow-empty').status, 0);
				assert.equal(git("log", "-1", "--format=%B"), "explicit");
				assert.equal(shell("update-ref refs/test-extension HEAD").status, 0);
				assert.equal(
					git("rev-parse", "refs/test-extension"),
					git("rev-parse", "HEAD"),
				);
				assert.equal(
					shell('-c alias.example="rev-parse HEAD" example').stdout.trim(),
					git("rev-parse", "HEAD"),
				);
				assert.equal(
					shell("log -1 --format=%s | tr a-z A-Z").stdout.trim(),
					"EXPLICIT",
				);
				assert.equal(
					shell("status --short; printf '\nchain-marker\n'")
						.stdout.trim()
						.endsWith("chain-marker"),
					true,
				);
			},
		);

		await t.test(
			"syntax errors and native failures do not manufacture a commit",
			() => {
				const head = git("rev-parse", "HEAD");
				assert.notEqual(shell('commit "nothing staged"').status, 0);
				assert.notEqual(shell('commit "unterminated').status, 0);
				assert.notEqual(shell("not-a-real-git-subcommand").status, 0);
				assert.equal(git("rev-parse", "HEAD"), head);
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
