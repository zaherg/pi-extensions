import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type IsFile,
	isMissingBinaryError,
	resolveExecutable,
} from "../executable.ts";

describe("resolveExecutable", () => {
	it("passes explicit POSIX and Windows paths through without searching PATH", () => {
		let checked = false;
		const exists: IsFile = () => {
			checked = true;
			return false;
		};
		assert.equal(
			resolveExecutable("./bin/git", "linux", {}, exists),
			"./bin/git",
		);
		assert.equal(
			resolveExecutable("/usr/bin/git", "darwin", {}, exists),
			"/usr/bin/git",
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

	it("resolves executable files on POSIX PATH while skipping relative entries, directories, and non-executable files", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-posix-exec-"));
		try {
			const relDir = join(tempDir, "rel");
			const nonExecDir = join(tempDir, "nonexec");
			const dirCollision = join(tempDir, "dircollision");
			const realBin = join(tempDir, "bin");
			mkdirSync(relDir, { recursive: true });
			mkdirSync(nonExecDir, { recursive: true });
			mkdirSync(join(dirCollision, "mytool"), { recursive: true });
			mkdirSync(realBin, { recursive: true });

			writeFileSync(join(relDir, "mytool"), "#!/bin/sh\n");
			chmodSync(join(relDir, "mytool"), 0o755);

			writeFileSync(join(nonExecDir, "mytool"), "#!/bin/sh\n");
			chmodSync(join(nonExecDir, "mytool"), 0o644);

			writeFileSync(join(realBin, "mytool"), "#!/bin/sh\n");
			chmodSync(join(realBin, "mytool"), 0o755);

			const pathValue = `::.:./rel:${nonExecDir}:${dirCollision}:${realBin}`;
			assert.equal(
				resolveExecutable("mytool", "linux", { PATH: pathValue }),
				join(realBin, "mytool"),
			);
			assert.equal(
				resolveExecutable("missing-tool", "darwin", { PATH: pathValue }),
				undefined,
			);
			assert.equal(
				resolveExecutable("mytool", "linux", { PATH: "" }),
				undefined,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
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

describe("isMissingBinaryError", () => {
	it("matches spawn ENOENT results case-insensitively only when not killed and stdout is empty", () => {
		assert.equal(
			isMissingBinaryError({
				killed: false,
				stdout: "",
				stderr: "spawn rtk ENOENT",
			}),
			true,
		);
		assert.equal(
			isMissingBinaryError({
				killed: false,
				stdout: "",
				stderr: "Spawn /usr/local/bin/git enoent",
			}),
			true,
		);
		assert.equal(
			isMissingBinaryError({
				killed: true,
				stdout: "",
				stderr: "spawn rtk ENOENT",
			}),
			false,
		);
		assert.equal(
			isMissingBinaryError({
				killed: false,
				stdout: "partial",
				stderr: "spawn rtk ENOENT",
			}),
			false,
		);
		assert.equal(
			isMissingBinaryError({
				killed: false,
				stdout: "",
				stderr: "fatal: not a git repository",
			}),
			false,
		);
	});
});
