import assert from "node:assert/strict";
import test from "node:test";
import { resolveExecutable } from "../executable.ts";

const files = (...paths: string[]) => {
	const set = new Set(paths.map((path) => path.toLowerCase()));
	return (path: string) => set.has(path.toLowerCase());
};

test("returns names unchanged outside Windows", () => {
	for (const platform of ["darwin", "linux"] as const) {
		assert.equal(resolveExecutable("rtk", platform, {}, () => false), "rtk");
	}
});

test("keeps names that already contain a path", () => {
	for (const name of ["C:\\tools\\rtk.exe", ".\\rtk.exe", "bin/rtk"]) {
		assert.equal(resolveExecutable(name, "win32", {}, () => false), name);
	}
});

test("resolves a bare name to the first .com or .exe in an absolute PATH entry", () => {
	const env = { PATH: "C:\\one;\"C:\\Program Files\\Git\\cmd\";\\\\server\\share\\bin" };
	assert.equal(
		resolveExecutable("git", "win32", env, files("C:\\Program Files\\Git\\cmd\\git.exe")),
		"C:\\Program Files\\Git\\cmd\\git.exe",
	);
	assert.equal(
		resolveExecutable("rtk", "win32", env, files("C:\\one\\rtk.com", "C:\\one\\rtk.exe")),
		"C:\\one\\rtk.com",
	);
	assert.equal(
		resolveExecutable("rtk", "win32", env, files("\\\\server\\share\\bin\\rtk.exe")),
		"\\\\server\\share\\bin\\rtk.exe",
	);
});

test("never resolves through the working directory or cwd-relative PATH entries", () => {
	// Every candidate "exists", so only the PATH filter can refuse them.
	const env = { Path: ";.;bin;.\\tools;C:relative;\\rooted" };
	assert.equal(resolveExecutable("rtk", "win32", env, () => true), undefined);
	assert.equal(resolveExecutable("rtk", "win32", {}, () => true), undefined);
});

test("reads a case-variant Path key and tries an explicit extension first", () => {
	assert.equal(
		resolveExecutable("rtk.exe", "win32", { Path: "D:\\bin" }, files("D:\\bin\\rtk.exe")),
		"D:\\bin\\rtk.exe",
	);
});
