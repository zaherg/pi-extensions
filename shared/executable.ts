import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export type IsFile = (path: string) => boolean;

const isFile: IsFile = (path: string): boolean => {
	try {
		return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
	} catch {
		return false;
	}
};

const isPosixExecutable: IsFile = (path: string): boolean => {
	try {
		if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

// Match only drive-absolute and UNC paths that do not depend on cwd.
const ABSOLUTE_WINDOWS_DIR = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;
const MISSING_BINARY_STDERR = /^spawn\b.*\bENOENT\b/i;

function windowsPath(env: NodeJS.ProcessEnv): string {
	if (env.PATH !== undefined) return env.PATH;
	const key = Object.keys(env).find(
		(name: string) => name.toUpperCase() === "PATH",
	);
	return (key && env[key]) || "";
}

/** Resolve a bare program name from absolute PATH entries without searching cwd. */
export function resolveExecutable(
	name: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	exists?: IsFile,
): string | undefined {
	if (!name) return undefined;
	if (platform === "win32") {
		if (/[\\/:]/.test(name)) return name;
		const check = exists ?? isFile;
		const candidates: string[] = [
			...(win32.extname(name) ? [name] : []),
			`${name}.com`,
			`${name}.exe`,
		];
		for (const raw of windowsPath(env).split(";")) {
			const dir = raw.trim().replace(/^"(.*)"$/, "$1");
			if (!ABSOLUTE_WINDOWS_DIR.test(dir)) continue;
			for (const candidate of candidates) {
				const path = win32.join(dir, candidate);
				if (check(path)) return path;
			}
		}
		return undefined;
	}

	if (name.includes("/")) return name;
	const check = exists ?? isPosixExecutable;
	for (const dir of (env.PATH ?? "").split(":")) {
		if (!posix.isAbsolute(dir)) continue;
		const candidate = posix.join(dir, name);
		if (check(candidate)) return candidate;
	}
	return undefined;
}

export function isMissingBinaryError(result: {
	readonly killed?: boolean;
	readonly stdout: string;
	readonly stderr: string;
}): boolean {
	return (
		!result.killed &&
		!result.stdout &&
		MISSING_BINARY_STDERR.test(result.stderr)
	);
}
