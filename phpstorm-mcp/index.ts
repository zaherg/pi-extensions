import { randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	McpServerConfig,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { isPhpStormRunning } from "./running.ts";

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
	if (!isRecord(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.command === "string") {
		return (
			record.command.trim().length > 0 &&
			(record.type === undefined || record.type === "stdio") &&
			record.url === undefined &&
			record.headers === undefined &&
			(record.args === undefined || isStringArray(record.args)) &&
			(record.env === undefined || isStringRecord(record.env))
		);
	}
	if (typeof record.url === "string") {
		return (
			record.url.trim().length > 0 &&
			(record.type === undefined || record.type === "http") &&
			record.command === undefined &&
			record.args === undefined &&
			record.env === undefined &&
			(record.headers === undefined || isStringRecord(record.headers))
		);
	}
	return false;
}

function readConfig(configPath: string): McpServerConfig {
	const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	if (!isMcpServerConfig(parsed)) {
		throw new Error(`Invalid PhpStorm MCP configuration in ${configPath}`);
	}
	return parsed;
}

export function isMcpDisabled(argv: readonly string[] = process.argv): boolean {
	const end = argv.indexOf("--");
	const flags = end === -1 ? argv : argv.slice(0, end);
	return flags.includes("--no-mcp");
}

export function resolvePhpStormCommand(
	home: string,
	systemApplicationsDir = "/Applications",
): string {
	const fallback = join(
		home,
		"Applications",
		"PhpStorm.app",
		"Contents",
		"MacOS",
		"phpstorm",
	);
	const candidates = [
		fallback,
		join(
			home,
			"Applications",
			"PhpStorm EAP.app",
			"Contents",
			"MacOS",
			"phpstorm",
		),
		join(
			systemApplicationsDir,
			"PhpStorm.app",
			"Contents",
			"MacOS",
			"phpstorm",
		),
		join(
			systemApplicationsDir,
			"PhpStorm EAP.app",
			"Contents",
			"MacOS",
			"phpstorm",
		),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

function defaultConfig(home: string): McpServerConfig {
	return {
		type: "stdio",
		env: {
			IJ_MCP_SERVER_PORT: "64442",
		},
		command: resolvePhpStormCommand(home),
		args: ["stdioMcpServer"],
	};
}

function loadOrCreateConfig(configPath: string, home: string): McpServerConfig {
	try {
		return readConfig(configPath);
	} catch (cause: unknown) {
		if (!isErrno(cause, "ENOENT")) {
			throw new Error(
				`Failed to load PhpStorm MCP configuration from ${configPath}`,
				{ cause },
			);
		}
	}

	const config = defaultConfig(home);
	const dir = dirname(configPath);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tempPath = join(
			dir,
			`.pi-phpstorm-mcp.${process.pid}.${randomUUID()}.tmp`,
		);
		try {
			writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			// Publish atomically via hard link to avoid clobbering concurrent writes or following symlinks.
			linkSync(tempPath, configPath);
			return config;
		} finally {
			try {
				unlinkSync(tempPath);
			} catch {}
		}
	} catch (cause: unknown) {
		if (isErrno(cause, "EEXIST")) {
			try {
				return readConfig(configPath);
			} catch (readCause: unknown) {
				throw new Error(
					`Failed to load PhpStorm MCP configuration from ${configPath}`,
					{ cause: readCause },
				);
			}
		}
		throw new Error(
			`Failed to create default PhpStorm MCP configuration at ${configPath}`,
			{ cause },
		);
	}
}

export default function phpstormMcp(pi: ExtensionAPI): void {
	let lifetime = new AbortController();

	pi.on("session_shutdown", (): void => {
		lifetime.abort();
	});

	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
			lifetime.abort();
			lifetime = new AbortController();
			const { signal } = lifetime;

			let mode: ExtensionContext["mode"];
			try {
				mode = ctx.mode;
			} catch {
				return;
			}
			if (mode !== "rpc" || isMcpDisabled()) return;
			if (!(await isPhpStormRunning(pi, process.platform, process.env, signal)))
				return;
			if (signal.aborted) return;

			const home = homedir();
			const configPath = join(home, ".pi", "agent", "pi-phpstorm-mcp.json");
			const config = loadOrCreateConfig(configPath, home);
			if (signal.aborted) return;

			try {
				pi.registerMcpServer("phpstorm", config);
			} catch (error: unknown) {
				if (
					signal.aborted ||
					(error instanceof Error && /stale after session/i.test(error.message))
				) {
					return;
				}
				throw error;
			}
		},
	);
}
