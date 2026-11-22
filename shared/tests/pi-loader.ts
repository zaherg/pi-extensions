import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function resolvePiModules(): string | undefined {
	const localModules = resolve("node_modules");
	if (existsSync(join(localModules, "@earendil-works", "pi-coding-agent"))) {
		return localModules;
	}
	if (process.env.PI_MODULES) {
		return resolve(process.env.PI_MODULES);
	}
	const agentDir =
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const versionFile = join(agentDir, "install", "current-version");
	let version: string;
	try {
		version = readFileSync(versionFile, "utf8").trim();
	} catch {
		return undefined;
	}
	if (!version) return undefined;
	const releaseModules = join(
		agentDir,
		"install",
		"releases",
		version,
		"node_modules",
	);
	return existsSync(releaseModules) ? releaseModules : undefined;
}

const piModules = resolvePiModules();
if (piModules) {
	const parentURL = pathToFileURL(join(piModules, "_entry.js")).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (
				specifier.startsWith("@earendil-works/") ||
				specifier === "typebox" ||
				specifier.startsWith("typebox/")
			) {
				return nextResolve(specifier, { ...context, parentURL });
			}
			return nextResolve(specifier, context);
		},
	});
}
