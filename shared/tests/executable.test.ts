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
	describe("POSIX platforms", () => {
		it("passes bare commands through unchanged on darwin and linux", () => {
			let checked = false;
			const exists: IsFile = () => {
				checked = true;
				return false;
			};
			assert.equal(resolveExecutable("git", "darwin", {}, exists), "git");
			assert.equal(resolveExecutable("rtk", "linux", {}, exists), "rtk");
			assert.equal(checked, false);
		});

		it("passes explicit absolute and relative paths through unchanged on POSIX", () => {
			assert.equal(
				resolveExecutable("/usr/local/bin/git", "darwin", {}),
				"/usr/local/bin/git",
			);
			assert.equal(resolveExecutable("./bin/git", "linux", {}), "./bin/git");
		});
	});

	describe("Windows explicit paths", () => {
		it("returns explicit absolute, UNC, relative, and drive-relative paths without searching PATH", () => {
			let checked = false;
			const exists: IsFile = () => {
				checked = true;
				return false;
			};
			const explicitPaths = [
				"C:\\Program Files\\Git\\cmd\\git.exe",
				"C:/Git/bin/git.exe",
				"\\\\server\\share\\tools\\git.exe",
				".\\git.exe",
				"./bin/git",
				"sub\\git.exe",
				"C:git.exe",
			];
			for (const candidate of explicitPaths) {
				assert.equal(
					resolveExecutable(candidate, "win32", { PATH: "C:\\Windows" }, exists),
					candidate,
				);
			}
			assert.equal(checked, false);
		});
	});

	describe("Windows PATH resolution", () => {
		it("resolves .exe from an absolute PATH entry", () => {
			const files = new Set(["C:\\Program Files\\Git\\cmd\\git.exe"]);
			const exists: IsFile = (filePath) => files.has(filePath);
			const result = resolveExecutable(
				"git",
				"win32",
				{ PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" },
				exists,
			);
			assert.equal(result, "C:\\Program Files\\Git\\cmd\\git.exe");
		});

		it("resolves .com and checks .com before .exe within the same PATH directory", () => {
			const checked: string[] = [];
			const files = new Set(["C:\\Tools\\demo.com", "C:\\Tools\\demo.exe"]);
			const exists: IsFile = (filePath) => {
				checked.push(filePath);
				return files.has(filePath);
			};
			const result = resolveExecutable(
				"demo",
				"win32",
				{ PATH: "C:\\Tools" },
				exists,
			);
			assert.equal(result, "C:\\Tools\\demo.com");
			assert.deepEqual(checked, ["C:\\Tools\\demo.com"]);
		});

		it("prefers earlier PATH directories over later ones", () => {
			const files = new Set(["C:\\First\\git.exe", "C:\\Second\\git.com"]);
			const exists: IsFile = (filePath) => files.has(filePath);
			const result = resolveExecutable(
				"git",
				"win32",
				{ PATH: "C:\\First;C:\\Second" },
				exists,
			);
			assert.equal(result, "C:\\First\\git.exe");
		});

		it("does not resolve .cmd or .bat for bare names even when PATHEXT lists them", () => {
			const files = new Set(["C:\\Tools\\tool.cmd", "C:\\Tools\\tool.bat"]);
			const exists: IsFile = (filePath) => files.has(filePath);
			const result = resolveExecutable(
				"tool",
				"win32",
				{
					PATH: "C:\\Tools",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				exists,
			);
			assert.equal(result, undefined);
		});

		it("checks an explicit extension first when the bare name already includes an extension", () => {
			const checked: string[] = [];
			const files = new Set(["C:\\Git\\git.exe"]);
			const exists: IsFile = (filePath) => {
				checked.push(filePath);
				return files.has(filePath);
			};
			const result = resolveExecutable(
				"git.exe",
				"win32",
				{ PATH: "C:\\Git" },
				exists,
			);
			assert.equal(result, "C:\\Git\\git.exe");
			assert.deepEqual(checked, ["C:\\Git\\git.exe"]);
		});

		it("still falls back to .com/.exe if a dotted bare name has no exact file match", () => {
			const files = new Set(["C:\\Tools\\python3.12.exe"]);
			const exists: IsFile = (filePath) => files.has(filePath);
			const result = resolveExecutable(
				"python3.12",
				"win32",
				{ PATH: "C:\\Tools" },
				exists,
			);
			assert.equal(result, "C:\\Tools\\python3.12.exe");
		});

		it("supports quoted PATH segments, surrounding whitespace, forward slashes, and UNC paths", () => {
			const files = new Set([
				"C:\\Program Files\\Git\\bin\\git.exe",
				"D:\\Apps\\rtk.exe",
				"\\\\fileserver\\bin\\sbx.exe",
			]);
			const exists: IsFile = (filePath) => files.has(filePath);

			assert.equal(
				resolveExecutable(
					"git",
					"win32",
					{ PATH: '  "C:\\Program Files\\Git\\bin" ; C:\\Other ' },
					exists,
				),
				"C:\\Program Files\\Git\\bin\\git.exe",
			);
			assert.equal(
				resolveExecutable("rtk", "win32", { PATH: "D:/Apps" }, exists),
				"D:\\Apps\\rtk.exe",
			);
			assert.equal(
				resolveExecutable(
					"sbx",
					"win32",
					{ PATH: "\\\\fileserver\\bin" },
					exists,
				),
				"\\\\fileserver\\bin\\sbx.exe",
			);
		});

		it("reads case-insensitive Path env var and honors an explicitly empty PATH", () => {
			const files = new Set(["C:\\Git\\git.exe"]);
			const exists: IsFile = (filePath) => files.has(filePath);

			assert.equal(
				resolveExecutable("git", "win32", { Path: "C:\\Git" }, exists),
				"C:\\Git\\git.exe",
			);
			assert.equal(
				resolveExecutable("git", "win32", { PATH: "", Path: "C:\\Git" }, exists),
				undefined,
			);
		});
	});

	describe("security and edge cases", () => {
		it("skips cwd, relative, drive-relative, root-relative, empty, and malformed PATH entries", () => {
			const checked: string[] = [];
			const files = new Set(["C:\\Safe\\git.exe"]);
			const exists: IsFile = (filePath) => {
				checked.push(filePath);
				return files.has(filePath);
			};

			const result = resolveExecutable(
				"git",
				"win32",
				{
					PATH: ";.;./bin;relative\\dir;C:drive-relative;\\root-relative;\\\\;\\\\\\bad;C:\\Safe",
				},
				exists,
			);
			assert.equal(result, "C:\\Safe\\git.exe");
			assert.deepEqual(checked, ["C:\\Safe\\git.com", "C:\\Safe\\git.exe"]);
		});

		it("returns undefined for empty or missing PATH and when binary is absent", () => {
			const exists: IsFile = () => false;
			assert.equal(resolveExecutable("git", "win32", {}, exists), undefined);
			assert.equal(
				resolveExecutable("git", "win32", { PATH: "" }, exists),
				undefined,
			);
			assert.equal(
				resolveExecutable("git", "win32", { PATH: ";;  ;" }, exists),
				undefined,
			);
			assert.equal(
				resolveExecutable(
					"git",
					"win32",
					{ PATH: "C:\\Windows;C:\\Tools" },
					exists,
				),
				undefined,
			);
		});

		it("skips a directory with a matching binary name and resolves a later real file", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-exec-test-"));
			try {
				const fakeDirEntry = join(tempDir, "dir-collision");
				const realFileEntry = join(tempDir, "real-bin");
				mkdirSync(join(fakeDirEntry, "git.exe"), { recursive: true });
				mkdirSync(realFileEntry, { recursive: true });
				writeFileSync(join(realFileEntry, "git.exe"), "binary");

				// Map Windows PATH entries onto real tempDir entries and check with statSync().isFile().
				const exists: IsFile = (winPath) => {
					const mapped = winPath
						.replace(/^C:\\Fake\\/, `${fakeDirEntry}/`)
						.replace(/^C:\\Real\\/, `${realFileEntry}/`);
					if (mapped === winPath) return false;
					return statSync(mapped, { throwIfNoEntry: false })?.isFile() ?? false;
				};

				const result = resolveExecutable(
					"git",
					"win32",
					{ PATH: "C:\\Fake;C:\\Real" },
					exists,
				);
				assert.equal(result, "C:\\Real\\git.exe");
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("returns undefined cleanly with default isFile when PATH entries do not exist on disk", () => {
			assert.equal(
				resolveExecutable("nonexistent-pi-binary", "win32", {
					PATH: "Z:\\definitely-does-not-exist-pi-ext",
				}),
				undefined,
			);
		});
	});
});
