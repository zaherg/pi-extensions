import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function phpstormMcp(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;

		const configPath = join(homedir(), ".pi", "agent", "pi-phpstorm-mcp.json");
		let config = {
			type: "stdio" as const,
			env: { IJ_MCP_SERVER_PORT: "64442" },
			command: "/Users/zaher/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
			args: ["stdioMcpServer"],
		};
		try {
			config = JSON.parse(readFileSync(configPath, "utf8"));
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Failed to load PhpStorm MCP configuration from ${configPath}`, { cause });
			}
		}
		pi.registerMcpServer("phpstorm", config);
	});
}
