import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

function isMcpServerConfig(value: unknown): value is McpServerConfig {
	if (!isRecord(value)) {
		return false;
	}
	if (typeof value.command === "string") {
		return value.type === undefined || value.type === "stdio";
	}
	if (typeof value.url === "string") {
		return value.type === undefined || value.type === "http";
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

function defaultConfig(home: string): McpServerConfig {
	return {
		type: "stdio",
		env: {
			IJ_MCP_SERVER_PORT: "64442",
		},
		command: join(home, "Applications", "PhpStorm.app", "Contents", "MacOS", "phpstorm"),
		args: ["stdioMcpServer"],
	};
}

function loadOrCreateConfig(configPath: string, home: string): McpServerConfig {
	try {
		return readConfig(configPath);
	} catch (cause: unknown) {
		if (!isErrno(cause, "ENOENT")) {
			throw new Error(`Failed to load PhpStorm MCP configuration from ${configPath}`, { cause });
		}
	}

	const config = defaultConfig(home);
	const dir = dirname(configPath);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tempPath = join(dir, `.pi-phpstorm-mcp.${process.pid}.${randomUUID()}.tmp`);
		try {
			writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
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
				throw new Error(`Failed to load PhpStorm MCP configuration from ${configPath}`, { cause: readCause });
			}
		}
		throw new Error(`Failed to create default PhpStorm MCP configuration at ${configPath}`, { cause });
	}
}

export default function phpstormMcp(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "rpc") return;
		if (!(await isPhpStormRunning(pi))) return;

		const home = homedir();
		const configPath = join(home, ".pi", "agent", "pi-phpstorm-mcp.json");
		pi.registerMcpServer("phpstorm", loadOrCreateConfig(configPath, home));
	});
}
