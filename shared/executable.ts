import { statSync } from "node:fs";
import { win32 } from "node:path";

type IsFile = (path: string) => boolean;

const isFile: IsFile = (path) => {
	try {
		return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
	} catch {
		return false;
	}
};

// Only drive-absolute (C:\dir) and UNC (\\server\share) entries. Relative,
// drive-relative (C:dir), and root-relative (\dir) entries depend on the cwd.
const ABSOLUTE_WINDOWS_DIR = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

function windowsPath(env: NodeJS.ProcessEnv): string {
	if (env.PATH !== undefined) return env.PATH;
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
	return (key && env[key]) || "";
}

/**
 * Resolve a bare program name without searching the working directory.
 *
 * On Windows, libuv checks the child's cwd before PATH for a bare name, so a
 * project containing `rtk.exe` or `git.exe` would run instead of the real tool.
 * There a bare name resolves to the first `.com`/`.exe` (the only files
 * CreateProcess can start without a shell) in an absolute PATH entry, or
 * `undefined` when none exists. Elsewhere exec only searches PATH, so names are
 * returned unchanged, as are names that already contain a path.
 */
export function resolveExecutable(
	name: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	exists: IsFile = isFile,
): string | undefined {
	if (platform !== "win32" || /[\\/:]/.test(name)) return name;
	const candidates = [
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
