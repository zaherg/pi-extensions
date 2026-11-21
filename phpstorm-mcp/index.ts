import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { isPhpStormRunning } from "./running.ts";

export default function phpstormMcp(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		if (!(await isPhpStormRunning(pi))) return;

		const configPath = join(homedir(), ".pi", "agent", "pi-phpstorm-mcp.json");
		let config: McpServerConfig;
		try {
			config = JSON.parse(readFileSync(configPath, "utf8"));
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
				// No built-in default: PhpStorm's path and MCP port differ per installation.
				if (ctx.hasUI) {
					ctx.ui.notify(`PhpStorm MCP was not registered: create ${configPath} with PhpStorm's MCP server settings.`, "warning");
				}
				return;
			}
			throw new Error(`Failed to load PhpStorm MCP configuration from ${configPath}`, { cause });
		}
		pi.registerMcpServer("phpstorm", config);
	});
}
