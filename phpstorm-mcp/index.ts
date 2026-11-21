import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { isPhpStormRunning } from "./running.ts";

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
		return JSON.parse(readFileSync(configPath, "utf8"));
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Failed to load PhpStorm MCP configuration from ${configPath}`, { cause });
		}
	}

	const config = defaultConfig(home);
	try {
		mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
		// `wx` avoids clobbering a file created concurrently or following a dangling symlink.
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		return config;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				return JSON.parse(readFileSync(configPath, "utf8"));
			} catch (readCause) {
				throw new Error(`Failed to load PhpStorm MCP configuration from ${configPath}`, { cause: readCause });
			}
		}
		throw new Error(`Failed to create default PhpStorm MCP configuration at ${configPath}`, { cause });
	}
}

export default function phpstormMcp(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		if (!(await isPhpStormRunning(pi))) return;

		const home = homedir();
		const configPath = join(home, ".pi", "agent", "pi-phpstorm-mcp.json");
		pi.registerMcpServer("phpstorm", loadOrCreateConfig(configPath, home));
	});
}
