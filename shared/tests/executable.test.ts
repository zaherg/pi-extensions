import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type IsFile, resolveExecutable } from "../executable.ts";

describe("resolveExecutable", () => {
	it("passes POSIX commands and explicit Windows paths through without searching PATH", () => {
		let checked = false;
		const exists: IsFile = () => {
			checked = true;
			return false;
		};
		assert.equal(resolveExecutable("git", "darwin", {}, exists), "git");
		assert.equal(
			resolveExecutable("./bin/git", "linux", {}, exists),
			"./bin/git",
		);
		assert.equal(
			resolveExecutable(
				"C:\\Git\\cmd\\git.exe",
				"win32",
				{ PATH: "C:\\Windows" },
				exists,
			),
			"C:\\Git\\cmd\\git.exe",
		);
		assert.equal(checked, false);
	});

	it("resolves .com/.exe on Windows PATH while skipping .cmd/.bat, relative entries, and directories", () => {
		const files = new Set([
			"C:\\Tools\\demo.com",
			"C:\\Tools\\demo.exe",
			"C:\\Program Files\\Git\\bin\\git.exe",
		]);
		const exists: IsFile = (p) => files.has(p);

		assert.equal(
			resolveExecutable("demo", "win32", { PATH: "C:\\Tools" }, exists),
			"C:\\Tools\\demo.com",
		);
		assert.equal(
			resolveExecutable(
				"git",
				"win32",
				{ PATH: ';.;relative\\dir;"C:\\Program Files\\Git\\bin"' },
				exists,
			),
			"C:\\Program Files\\Git\\bin\\git.exe",
		);
		assert.equal(
			resolveExecutable(
				"script",
				"win32",
				{ PATH: "C:\\Tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
				(p) => p.endsWith(".cmd") || p.endsWith(".bat"),
			),
			undefined,
		);
		assert.equal(
			resolveExecutable("git", "win32", { PATH: "" }, exists),
			undefined,
		);

		const tempDir = mkdtempSync(join(tmpdir(), "pi-exec-"));
		try {
			const dirCollision = join(tempDir, "dir");
			const realBin = join(tempDir, "bin");
			mkdirSync(join(dirCollision, "git.exe"), { recursive: true });
			mkdirSync(realBin, { recursive: true });
			writeFileSync(join(realBin, "git.exe"), "bin");

			const mappedExists: IsFile = (winPath) => {
				const mapped = winPath
					.replace(/^C:\\Fake\\/, `${dirCollision}/`)
					.replace(/^C:\\Real\\/, `${realBin}/`);
				return (
					mapped !== winPath &&
					(statSync(mapped, { throwIfNoEntry: false })?.isFile() ?? false)
				);
			};
			assert.equal(
				resolveExecutable(
					"git",
					"win32",
					{ PATH: "C:\\Fake;C:\\Real" },
					mappedExists,
				),
				"C:\\Real\\git.exe",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
