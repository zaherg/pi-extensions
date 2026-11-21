import { statSync } from "node:fs";
import { win32 } from "node:path";

export type IsFile = (path: string) => boolean;

const isFile: IsFile = (path: string): boolean => {
	try {
		return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
	} catch {
		return false;
	}
};

// Match only drive-absolute and UNC paths that do not depend on cwd.
const ABSOLUTE_WINDOWS_DIR = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

function windowsPath(env: NodeJS.ProcessEnv): string {
	if (env.PATH !== undefined) return env.PATH;
	const key = Object.keys(env).find((name: string) => name.toUpperCase() === "PATH");
	return (key && env[key]) || "";
}

/** Resolve a bare program name from absolute PATH entries on Windows without searching cwd. */
export function resolveExecutable(
	name: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	exists: IsFile = isFile,
): string | undefined {
	if (platform !== "win32" || /[\\/:]/.test(name)) return name;
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
			if (exists(path)) return path;
		}
	}
	return undefined;
}
