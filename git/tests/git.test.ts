import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gitShellCommand } from "../index.ts";
import {
	CAPTURE_BYTES,
	gitResultMessage,
	terminalCaptureArgs,
} from "../terminal.ts";

describe("gitShellCommand", () => {
	it("rewrites standalone quoted commit messages and passes other git commands through", () => {
		assert.equal(gitShellCommand(""), "git");
		assert.equal(gitShellCommand("   \t\r\n "), "git");
		assert.equal(gitShellCommand("status -sb"), "git status -sb");
		assert.equal(
			gitShellCommand('commit "Fix \\"quoted\\" validation"'),
			'git commit -m "Fix \\"quoted\\" validation"',
		);
		assert.equal(
			gitShellCommand("  commit   'line 1\nline 2'  "),
			"git commit -m 'line 1\nline 2'",
		);

		for (const passthrough of [
			'commit -m "Fix"',
			'commit "Fix" --amend',
			'commit "first" "second"',
			"commit 'msg' && git push",
			'commit "unterminated',
			'commit "trailing\\',
			"commit unquoted",
		]) {
			assert.equal(gitShellCommand(passthrough), `git ${passthrough}`);
		}
	});
});

describe("terminalCaptureArgs", () => {
	it("builds positional script capture args for darwin and linux and rejects other platforms", () => {
		const shell = '/bin/zsh "$(echo unsafe)"';
		const command = 'git commit -m "$(id)"';

		const darwin = terminalCaptureArgs(shell, command, "darwin");
		assert.equal(darwin[0], "-c");
		assert.equal(darwin[3], shell);
		assert.equal(darwin[4], command);
		assert.equal(darwin[5], String(CAPTURE_BYTES + 1));
		assert.match(darwin[1] ?? "", /\/usr\/bin\/script -q \/dev\/null/);
		assert.equal((darwin[1] ?? "").includes(command), false);

		const linux = terminalCaptureArgs("/bin/bash", "git status", "linux");
		assert.match(
			linux[1] ?? "",
			/SHELL="\$1" \/usr\/bin\/script -q -e -c "\$2" \/dev\/null/,
		);

		assert.throws(
			() => terminalCaptureArgs("/bin/sh", "git status", "win32"),
			/Git terminal capture requires macOS or Linux/,
		);
	});
});

describe("gitResultMessage", () => {
	it("formats status headers, truncates bounded tail output, and redacts credentials/ANSI", () => {
		assert.equal(
			gitResultMessage(Buffer.from("On branch main\n"), 0),
			"Git shell completed.\nOn branch main",
		);
		assert.equal(
			gitResultMessage(Buffer.alloc(0), 0),
			"Git shell completed.\n(No output)",
		);
		assert.equal(
			gitResultMessage(Buffer.from("fatal: not a git repository\n"), 128),
			"Git command failed (exit 128).\nfatal: not a git repository",
		);
		assert.equal(
			gitResultMessage(Buffer.from("partial\n"), null, "SIGINT"),
			"Git shell stopped by SIGINT. Check git status before retrying.\npartial",
		);

		// Drops partial first line when output exceeds CAPTURE_BYTES
		const overLimit = Buffer.from(
			`${"a".repeat(CAPTURE_BYTES - 5)}\nfinal line\n`,
			"utf8",
		);
		assert.equal(
			gitResultMessage(overLimit, 0),
			"Git shell completed.\n[Last output only]\nfinal line",
		);

		// Redacts credentials and strips ANSI/control sequences
		const dirty = Buffer.from(
			"\u001b[32mremote:\u001b[0m https://alice:supersecret@github.com/org/repo.git\r\ntoken=ghp_1234567890abcdefghij1234567890\n",
			"utf8",
		);
		const cleaned = gitResultMessage(dirty, 1);
		assert.equal(cleaned.includes("supersecret"), false);
		assert.equal(cleaned.includes("ghp_"), false);
		assert.equal(cleaned.includes("\u001b["), false);
		assert.match(cleaned, /https:\/\/\[REDACTED\]@github\.com\/org\/repo\.git/);
	});
});
